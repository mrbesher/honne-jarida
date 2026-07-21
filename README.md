# Honne Jarida

Private Telegram bot for tracking income and expenses.

```sh
npm install
npm test
npm run typecheck
npx wrangler d1 migrations apply honne-jarida --remote
npm run deploy
WORKER_URL=https://your-worker.workers.dev ./scripts/setup-telegram.sh
```
