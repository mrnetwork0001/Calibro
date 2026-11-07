# Tatum AI Builder module (ai.tatum.io)

This folder is reserved for the module generated on **https://ai.tatum.io**, kept separate so its provenance stays clear.

It is currently **empty on purpose**. Nothing in Calibro claims to be AI-Builder-generated until the real export is placed here.

To fill it:
1. Run the prompt in [`docs/AI_TATUM_BOOTSTRAP_PROMPT.md`](../../../docs/AI_TATUM_BOOTSTRAP_PROMPT.md) on ai.tatum.io.
2. Export the generated component(s) into this folder unchanged, and commit them in their own commit ("Import ai.tatum.io export"), so the diff shows exactly what was generated.
3. Add `PROVENANCE.md` here with the ai.tatum.io project URL, the date and a screenshot.
4. Adapt the code in later commits, for example wiring it to `/api/status` and `/api/markets`.
