# Subsequent browser checks

The designer's initial handoff correctly recorded that direct `file:` navigation was blocked. The primary subsequently used a restricted HTTP preview on `127.0.0.1:4311`, serving only this authored HTML file. There is no directory access; a content policy disables external connections and resources. The browser accepted this permitted HTTP preview. No blocked file navigation, alternate browser or raw browser command was used.

Actual in-app browser checks confirmed:

- Overview displays the business purpose, current brief revision, available check count and explicit distinction between check availability and test coverage.
- Brief & requirements shows editable business purpose, actors/components, message vocabulary, failure concerns and source-context declaration, plus ten readable public rules with check IDs.
- Extra contextual and unsupported requirements are distinguished from executable checks.
- Editing business purpose produces an unsaved state; saving creates revision4. The synthetic saved investigation continues to show its pinned revision2, rather than adopting the latest brief.
- Switching to the payments draft shows zero executable checks and no configured adapter. Its illustrative Start control and target selection are disabled.
- Reload returns the deliberately in-page prototype data to its initial state, as the persistent prototype banner explains.
- Prepare investigation shows the pinned saved revision, source-scope disclosure, check availability and disabled live provider. Starting the manually advanced walkthrough is explicitly synthetic. One rejection increases only the rejected-proposal count; the corrected example increases executed experiments. Stop disables progression, retains the partial activity and says no confirmed finding. This is an interaction check, not real execution.

Captured views: `preview-overview.png`, `preview-requirements.png`, `preview-revisions.png`, `preview-activity.png`. The revision screenshot shows the temporary revision 4 created during this check; the activity screenshot shows the stopped illustrative walkthrough. The prototype was reset afterwards.

These checks verify the selected design interactions, not backend persistence, real model execution, production adapter support or comprehensive accessibility. All investigation evidence in this prototype is labelled synthetic. The real system-brief implementation is a separate workstream.
