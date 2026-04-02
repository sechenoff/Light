# Verify

Run project health checks. Invoke with `/verify`.

## Steps

1. TypeScript compilation check (API):
```bash
cd apps/api && npx tsc --noEmit 2>&1 | tail -20
```

2. TypeScript compilation check (Web):
```bash
cd apps/web && npx tsc --noEmit 2>&1 | tail -20
```

3. TypeScript compilation check (Bot):
```bash
cd apps/bot && npx tsc --noEmit 2>&1 | tail -20
```

4. Run tests:
```bash
cd apps/web && npx vitest run 2>&1 | tail -30
```

5. Git status:
```bash
git status --short
```

Report results with pass/fail for each step.
