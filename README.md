# aop-shell

A casca da plataforma do testbed de Codificação de Aplicações da TV 3.0: a página da TV, com as
camadas de exibição e os avisos, e as telas que a plataforma mostra nelas, que são o seletor e o
gestor de perfis, o catálogo de aplicações e a aplicação bootstrap de cada serviço.

Este repositório é submódulo do [TV30](https://github.com/multisens/TV30) e sobe pelo
`docker-compose.yml` da raiz dele.

**Documentação:** <https://multisens.com.br/TV30/aop-shell/>

## Desenvolver e testar

- Rodar fora do Docker, com `npm run dev`:
  [Desenvolvimento com serviço no host](https://multisens.com.br/TV30/dev-local/#casca-aop-shell-no-host).
- Testes: `npm test`; as suítes com a stack de pé estão em
  [Como testar](https://multisens.com.br/TV30/como-testar/).

## Licença

Apache-2.0; veja o `LICENSE`.
