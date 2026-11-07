**Submission audit** against `docs/SUBMISSION_CHECKLIST.md`.

1. Hackathon checklist: Walrus Memory writing on Mainnet, Tatum RPC for on-chain data, ≥ 10 memories, published blog post, working demo and public repo.
2. Judging: Walrus + Tatum integration (30%), technical quality (30%), creativity (20%), presentation (20%), social post bonus.
3. Run `npm run typecheck && npm test && npm run build`; check no secrets are tracked (`git ls-files`, `.gitignore`).
4. Check every number in `README.md` and `docs/BLOG_POST.md` against `docs/mainnet-memory-proof.json` and the live `/api/status` / `/api/record`.
5. Walk the demo in `docs/DEMO_RUNBOOK_3MIN.md` end to end and report what fails.
