# Explicação do Projeto — CaseCellShop

## O que é esse projeto

Esse repositório é o backend de uma loja fictícia chamada CaseCellShop. Ela vende capinhas de celular e está crescendo rápido demais.

O backend é o servidor que responde requisições HTTP. Ou seja, quando alguém quer ver os produtos ou fazer um pedido, quem responde é esse código aqui.

Não tem front-end nesse projeto. Não tem tela bonita. Só a API. Você testa com curl, Postman ou qualquer cliente HTTP.

Também não tem banco de dados de verdade. Tudo fica na memória do processo Node.js. Quando você reinicia o servidor, pedidos, cache e fila somem. Isso é de propósito — o desafio pediu para demonstrar os conceitos sem montar infraestrutura externa.

---



## O contexto de negócio

A CaseCellShop precisa de três coisas básicas.

Primeiro, mostrar o catálogo de produtos. A vitrine precisa ser rápida, porque o cliente não vai esperar.

Segundo, aceitar pedidos. Alguém escolhe um produto, informa a quantidade, e a loja precisa registrar isso.

Terceiro, permitir consultar o status de um pedido. O cliente quer saber se deu certo, se ainda está processando, ou se falhou.

Parece simples, mas tem um detalhe importante: existe um ERP por trás de tudo.

ERP significa Enterprise Resource Planning. Na prática, é o sistema legado da empresa — aquele software antigo que controla estoque e faturamento. Ele é crítico, lento, e no cenário do desafio a gente não pode alterá-lo.

Por isso a gente simula o ERP em código. Ele demora uns 200 milissegundos para devolver o catálogo e uns 300 para faturar um pedido. E falha aleatoriamente em cerca de vinte por cento das chamadas. Assim conseguimos testar o que aconteceria com um sistema externo instável, sem depender de um ERP real.

---



## Os três problemas que o desafio pede para resolver

Antes de falar de arquivos, deixa eu te contar os três problemas que motivam quase toda decisão técnica aqui.

O primeiro problema é a vitrine lenta. Se toda visita na loja bater direto no ERP, a página fica pesada e o ERP sofre. A solução é cache — guardar uma cópia temporária do catálogo e só ir ao ERP quando precisar.

O segundo problema é overselling. Overselling é vender mais do que tem em estoque. Isso acontece quando duas compras chegam ao mesmo tempo, as duas leem "tem 1 unidade", e as duas passam. A solução é debitar estoque de forma atômica — checar e subtrair num único bloco, sem pausa no meio.

O terceiro problema é checkout lento e instável. Se o cliente ficar esperando o ERP faturar antes de receber resposta, a experiência fica ruim. E quando o ERP falha, pior ainda. A solução é checkout assíncrono: a API aceita o pedido rápido, responde 202, e um worker processa o faturamento depois, em background.

Esses três problemas aparecem nos testes automatizados e guiam praticamente tudo que você vai ver no código.

---



## Stack tecnológica — o que usamos e por quê

O projeto roda em Node.js, versão 18 ou superior. Node é bom para servidores que fazem muito I/O — muitas requisições HTTP entrando e saindo.

Usamos TypeScript em cima do JavaScript. TypeScript adiciona tipos. Isso ajuda o editor a avisar erros antes de rodar e deixa o código mais legível quando você volta nele depois de uma semana.

Express é a única dependência de runtime. Express é um framework minimalista para criar rotas HTTP. Para três rotas, não precisamos de nada mais pesado.

Para rodar TypeScript direto, usamos tsx nos scripts npm. Assim você não precisa compilar manualmente antes de desenvolver.

Para testes, usamos node:test e node:assert, que já vêm com o Node. Zero dependência extra de Jest ou similar.

E para guardar dados, usamos Map, Set e Array nativos do JavaScript. Sem Redis, sem Postgres, sem fila externa.

---



## Visão geral da arquitetura

Tudo roda em um único processo. Quando você dá npm run dev, sobe uma API na porta 3000 e, no mesmo processo, um worker que acorda a cada dois segundos.

Pensa assim: a API é o balcão da loja. O worker é o funcionário de bastidor que manda o pedido pro ERP.

Os arquivos principais se conectam assim. O server.ts liga tudo. O app.ts define as rotas HTTP. O db.ts guarda estado e regras de negócio. O erp.ts simula o sistema legado. O worker.ts processa a fila de pedidos. O observability.ts cuida de logs, métricas e rastreamento. E o test.ts garante que tudo funciona.

Não tem microserviços aqui. Não tem container separado pro worker. É proposital — o foco é clareza, não escala horizontal.

---



## server.ts — o interruptor

Esse arquivo tem sete linhas. É o ponto de entrada.

Ele importa a aplicação Express, importa o logger, chama startWorker para ligar o processamento em background, e depois app.listen na porta 3000.

A ordem importa um pouco: o worker começa antes da API ficar no ar. Assim, quando a primeira requisição de checkout chegar, já tem alguém processando a fila.

Analogia simples: é o interruptor que abre a loja e coloca o funcionário de bastidor no turno ao mesmo tempo.

---



## app.ts — as três rotas HTTP

Esse arquivo monta o Express e define as três rotas da API.

No início, ele configura express.json para interpretar corpo JSON, e usa o correlationMiddleware para injetar IDs de rastreamento em cada requisição.

A primeira rota é GET /products. Ela chama getProductsCatalog no db.ts. Se der certo, retorna 200 com a lista de produtos. Se o ERP estiver fora e não tiver cache antigo para fallback, retorna 503.

A segunda rota é POST /checkout. Ela valida o corpo da requisição: precisa ter productId, quantity inteiro maior ou igual a 1, e o header Idempotency-Key. Sem esse header, retorna 400.

Depois chama acceptCheckout, que é síncrona — repara que não tem await aqui. Isso é intencional. Queremos que checagem de estoque e débito aconteçam num bloco contínuo, sem outra requisição entrar no meio pelo event loop do Node.

Três resultados possíveis. Se a Idempotency-Key já foi usada, é um replay idempotente — retorna 202 com o mesmo orderId de antes, sem debitar estoque de novo. Se deu erro de negócio, como produto inexistente ou estoque insuficiente, retorna 400. Se aceitou, retorna 202 com status PENDING.

A terceira rota é GET /orders/:orderId/status. Busca o pedido no ordersDb. Achou, retorna 200 com id e status. Não achou, retorna 404.

---



## db.ts — o coração do estado

Esse é o arquivo mais importante para entender a lógica de negócio.

Ele guarda tudo em estruturas na memória. O productsDb é um Map com o estoque real — essa é a fonte da verdade local. Começa com um produto seed: Capinha A, id 123, preço 29,90, estoque 10.

O cache guarda uma cópia do catálogo com tempo de expiração. TTL de cinco segundos. Depois disso, considera expirado.

O ordersDb guarda os pedidos e seus status: PENDING, SUCCESS ou FAILED.

A queue é um array FIFO — first in, first out — com IDs de pedidos esperando faturamento.

A dlq é a Dead Letter Queue, a fila dos mortos. Pedidos que falharam três vezes no ERP vão parar aqui.

O idempotencyMap liga cada Idempotency-Key ao orderId correspondente. Assim, repetir a mesma requisição não cria pedido duplicado.

E tem a fetchPromise, uma Promise compartilhada. Isso é a proteção contra cache stampede — explico já já.

---



## tryDebitStock — como evitamos overselling

A função tryDebitStock espelha este SQL mental: UPDATE products SET stock = stock - quantidade WHERE id = produto AND stock >= quantidade.

Ela busca o produto. Se não existe, retorna not_found. Se o estoque é menor que a quantidade pedida, retorna insufficient. Se passou, subtrai e retorna ok.

Tudo isso é síncrono. Não tem await entre ler o estoque e debitar. Por quê? Porque no Node, código síncrono roda até o fim sem ser interrompido por outra requisição. Isso fecha a janela de corrida que causaria overselling.

Em produção, essa lógica iria para um UPDATE atômico no banco de dados. Aqui, o bloco síncrono simula esse comportamento num processo único.

---



## acceptCheckout — o fluxo do pedido na API

Quando alguém faz checkout, acceptCheckout roda nesta ordem, tudo síncrono.

Primeiro, verifica se a Idempotency-Key já existe. Se sim, devolve replay com o orderId antigo e o status atual. Fim. Não debita de novo.

Segundo, chama tryDebitStock. Se falhou, retorna erro.

Terceiro, cria o pedido com status PENDING no ordersDb. Gera um orderId no formato ORD-timestamp-número aleatório.

Quarto, grava a Idempotency-Key no idempotencyMap.

Quinto, invalida o cache do catálogo com cache.delete('products'). Por quê? Porque o estoque mudou. A vitrine precisa refletir isso na próxima consulta.

Sexto, enfileira o orderId na queue para o worker processar depois.

E retorna accepted com o orderId.

Repara numa decisão importante: o estoque é debitado aqui na API, não no worker. A razão é evitar overselling. Só entra na fila quem já garantiu estoque. O trade-off é que, se o faturamento falhar definitivamente, o estoque não volta automaticamente. O pedido vai para a DLQ e fica lá até reconciliação.

---



## getProductsCatalog — cache-aside com fallback

Essa função implementa o padrão cache-aside para o catálogo.

Primeiro, olha se tem cache válido — ou seja, se expiresAt ainda é maior que agora. Se sim, incrementa cache_hit, registra log e span, e retorna os dados. Resposta instantânea, ERP nem é chamado.

Se o cache expirou ou está vazio, é cache miss. Incrementa cache_miss.

Aí entra a proteção anti-stampede. Se várias requisições chegam ao mesmo tempo com cache expirado, todas poderiam chamar o ERP juntas. Para evitar isso, usamos fetchPromise. Se já existe uma Promise buscando no ERP, as outras requisições aguardam a mesma Promise. Uma chamada só.

Se não existe fetchPromise, cria uma chamando simulateErpFetch. Se der certo, salva no cache com expiresAt igual a agora mais cinco segundos, limpa fetchPromise, e retorna os dados.

Se der errado, limpa fetchPromise e cai no catch. Aí verifica se existe cache expirado — stale cache. Se existe, usa como fallback e retorna 200 com dado antigo. Melhor mostrar estoque de cinco segutos atrás do que derrubar a vitrine.

Se não tem stale cache, retorna erro ERP indisponível, que vira 503 na rota.

Por que TTL de cinco segundos? Balanceia frescor dos dados com performance. Cache muito longo esconde mudanças de estoque. Cache muito curto não alivia o ERP. Cinco segundos é um meio-termo razoável para vitrine, especialmente com invalidação no checkout.

---



## erp.ts — simulando o sistema legado

Esse arquivo substitui um ERP real.

simulateErpFetch demora cerca de 200 milissegundos e falha aleatoriamente em vinte por cento das vezes, a menos que os testes forcem outro comportamento.

simulateErpOrderCreation demora cerca de 300 milissegundos, com a mesma taxa de falha aleatória.

Tem um Set chamado processedOrders. Se o mesmo orderId chegar de novo — por retry ou reconciliação — o ERP simula sucesso imediato sem reprocessar. Isso modela idempotência do lado do ERP.

Para testes, existem hooks: setErpFetchBehavior e setErpOrderBehavior permitem forçar alwaysSucceed ou alwaysFail. getErpFetchCallCount conta quantas vezes o ERP foi chamado — usado no teste de stampede. resetErpBehavior volta ao padrão.

Por que simular? Porque precisamos testar retry, DLQ e fallback stale de forma reproduzível. Depender de falhas aleatórias reais tornaria os testes flaky — ou seja, passariam às vezes e falhariam outras.

---



## worker.ts — o funcionário de bastidor

O worker roda a cada dois segundos via setInterval.

Tem uma guarda processing para evitar ciclos sobrepostos. Se o ciclo anterior ainda está rodando, o novo ignora. Isso evita processar a mesma fila duas vezes ao mesmo tempo.

Se a queue tem pedidos, drena todos no ciclo — processa um por um até esvaziar. Não processa só um por vez de propósito, para não acumular backlog desnecessário.

Se a queue está vazia, tenta reconciliar um item da DLQ.

A função processOne tenta faturar no ERP até três vezes. Entre tentativas, espera com backoff exponencial: 200 milissegundos na segunda tentativa, 400 na terceira.

Se alguma tentativa funciona, muda status para SUCCESS, incrementa checkout_processed, registra log e span, e pronto.

Se as três falham, muda status para FAILED, coloca na dlq, incrementa checkout_failed, e registra erro. O estoque não volta — o pedido fica na DLQ aguardando reconciliação.

A função reconcileDlq roda quando a fila principal está ociosa. Pega um pedido da DLQ, tenta faturar de novo. Se der certo, status SUCCESS, remove da DLQ, incrementa checkout_reconciled. Se falhar, mantém na DLQ para tentar no próximo ciclo.

A cada dez segundos, o worker emite um log metrics_snapshot com contadores, profundidade da fila, profundidade da DLQ, estoque total, e histogramas de latência. Isso simula o que um dashboard de observabilidade consumiria em produção.

stopWorker existe para os testes pararem os intervals no final.

---



## observability.ts — enxergar o que acontece

Observabilidade é logs, métricas e traces — tudo que ajuda a entender o sistema em produção.

O logger escreve JSON estruturado no console. Cada linha tem timestamp, level, msg e campos extras. Logs JSON são fáceis de filtrar em ferramentas como Datadog ou Grafana Loki.

O correlationMiddleware roda em toda requisição HTTP. Lê X-Correlation-Id do header ou gera um UUID novo. Gera também um X-Request-Id único por requisição. Devolve ambos nos headers de resposta.

Correlation ID acompanha todo o fluxo — do checkout até o worker. Request ID identifica uma chamada HTTP individual. Analogia: correlationId é o número do pedido na operação logística. requestId é o número da tentativa de atendimento no balcão.

A função span registra quanto tempo uma operação levou e alimenta histogramas de latência. Em produção, isso evoluiria para OpenTelemetry.

As métricas ficam em memória: cache_hit, cache_miss, checkout_processed, checkout_failed, checkout_reconciled. Não tem endpoint /metrics — tudo sai via logs JSON.

---



## Os três fluxos principais — passo a passo

Fluxo um: listar produtos. Cliente chama GET /products. Se cache válido, retorna na hora. Se cache miss, uma Promise busca no ERP. ERP responde, salva cache por cinco segundos, retorna 200. ERP falha mas tem stale, retorna 200 com dado antigo. ERP falha sem stale, retorna 503.

Fluxo dois: fazer checkout. Cliente chama POST /checkout com productId, quantity e Idempotency-Key. Valida payload. Chave repetida, replay 202. Estoque insuficiente, 400. Tudo ok, debita estoque, cria pedido PENDING, invalida cache, enfileira, retorna 202.

Fluxo três: worker processa. A cada dois segundos, pega pedido da fila, tenta faturar no ERP até três vezes. Sucesso, status SUCCESS. Falha definitiva, status FAILED e vai pra DLQ. Quando fila vazia, tenta recuperar um da DLQ.

O cliente consulta GET /orders/orderId/status para acompanhar. Começa PENDING, evolui para SUCCESS ou FAILED. Tipicamente leva de dois a seis segundos depois do checkout.

---



## Decisões e trade-offs — por que cada escolha

Estado em memória. Escolhemos porque o desafio pediu sem infra externa. Custo: restart apaga tudo, não escala horizontalmente — duas instâncias teriam estoques diferentes.

Cache-aside com TTL curto. Escolhemos para aliviar o ERP legado. Custo: dados podem ter até cinco segundos de atraso. Mitigamos com invalidação no checkout e fallback stale.

Anti-stampede com fetchPromise. Escolhemos para evitar avalanche no ERP quando cache expira. Custo: funciona num processo só; produção precisaria lock distribuído, tipo Redis.

Checkout assíncrono com 202. Escolhemos porque ERP é lento e falha muito; cliente não deve esperar. Custo: consistência eventual — status começa PENDING. Em produção, notificaria o cliente quando mudar.

Estoque debitado na API. Escolhemos para evitar overselling. Custo: se faturamento falha de vez, estoque não volta sozinho — reconciliação manual ou automática via DLQ.

Invalidação total do cache no checkout. Escolhemos pela simplicidade — apaga cache inteiro, próximo /products recarrega tudo. Custo: próximo acesso é miss, mais lento. Alternativa seria invalidar só o produto alterado.

Idempotência com Map local. Escolhemos porque rede instável reenvia POST. Custo: num processo só; multi-instância precisaria store compartilhado como Redis.

ERP simulado. Escolhemos porque ERP legado não pode ser alterado e precisamos de testes controlados. Custo: comportamento real pode ter timeouts, autenticação e formatos diferentes.

---



## Como rodar e testar

Instala dependências com npm install.

Sobe API e worker com npm run dev. API fica em localhost:3000.

Testa catálogo: curl [http://localhost:3000/products](http://localhost:3000/products). Primeira chamada demora ~200ms por causa do ERP. Segunda chamada dentro de cinco segundos é instantânea.

Testa checkout: curl -X POST com Content-Type application/json, header Idempotency-Key, e corpo com productId e quantity. Resposta 202 com orderId e status PENDING.

Testa status: curl [http://localhost:3000/orders/ORDER_ID/status](http://localhost:3000/orders/ORDER_ID/status). Aguarda alguns segundos e consulta de novo para ver SUCCESS ou FAILED.

Roda testes automatizados com npm test. Usa porta 3001 para não conflitar com dev. Reseta estado, sobe servidor de teste, controla comportamento do ERP, e roda onze cenários cobrindo cache, overselling, idempotência, worker, DLQ e reconciliação.

Verifica tipos com npm run typecheck.

Contrato completo da API está no openapi.yaml.

---



## O que mudaria em produção

Em produção, o estado iria para banco de dados — Postgres ou similar — com UPDATE atômico de estoque.

O cache iria para Redis distribuído, com lock para anti-stampede entre instâncias.

A fila iria para RabbitMQ, SQS ou similar, com worker em processo separado ou até serviço dedicado.

Idempotência iria para store compartilhado com operação atômica insert-or-get.

Observabilidade evoluiria para OpenTelemetry, Prometheus, alertas de fila crescente e DLQ acumulada.

Teria autenticação, pagamento real, notificação ao cliente quando status mudar, e deploy em nuvem.

Mas os conceitos seriam os mesmos: cache-aside, débito atômico, checkout assíncrono, idempotência, retry com backoff, DLQ e reconciliação.

---



## Resumo final

Esse projeto é um backend de loja que resolve vitrine lenta com cache, overselling com débito atômico síncrono, e checkout instável com fila e worker assíncrono.

Tudo roda num processo Node.js com Express, estado em memória, ERP simulado, e observabilidade via logs JSON.

Três rotas: GET /products, POST /checkout, GET /orders/id/status.

Sete arquivos principais em src: server liga tudo, app define rotas, db guarda estado e regras, erp simula legado, worker processa fila, observability registra o que acontece, test garante que funciona.

Se você entendeu esses três problemas, essas três rotas, e por que cada decisão foi tomada, você entendeu o projeto inteiro.

Qualquer dúvida, abre o código com esse roteiro na cabeça e vai arquivo por arquivo. O README tem mais detalhe técnico. O RESPOSTAS.md tem as respostas conceituais do desafio. Mas essa explicação aqui é o mapa mental — o que você precisa antes de mergulhar nos detalhes.