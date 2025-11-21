name: CI

on:
  push:
    branches: ['**']
  pull_request:

jobs:
  quality:
    name: Format check & Knip
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 'latest'

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run format check
        run: bun run format:check

      - name: Run lints
        run: bun run lint

      - name: Run typecheck
        run: bun run typecheck

      - name: Run knip
        run: bun run knip
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
