# Books to Scrape Site Adapter

Official low-risk adapter pack for the public Books to Scrape sandbox site. Its
product extraction capability is read-only; the pack also contains a constrained
`save-search-draft` Procedure sample.

## Capability

- `books_to_scrape.extract_product`

## Runners

- Fixture runner for regression.
- Browser snapshot runner for target runtime smoke.
- Procedure runner for the low-risk saved-search draft flow.

## Repair Scope

Repairs are limited to extractor, verifier, fixture, and expected-output files. Framework core,
schema authority, main process code, secrets, and dataset/profile services are out of scope.
