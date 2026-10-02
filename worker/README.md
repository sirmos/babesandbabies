# Worker catalog note

The product and service prices in the catalog are placeholders only. Replace the placeholder values in `catalog.json` before you go live.

- Prices are stored as strings in USD, for example `"5.00"`.
- Update any amount before production deployment.
- The checkout routes calculate totals on the server from this file and never trust a browser-supplied price.
