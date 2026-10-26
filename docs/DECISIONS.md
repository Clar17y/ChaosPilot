# Accepted decisions

The discovery plan was approved on 26 October 2026. The implementation budget is 30 hours of the participant's attention, including evaluation and submission preparation.

| Decision | Reason |
| --- | --- |
| Automation engineers are the primary user | Reduce expert effort designing and proving negative scenarios. |
| New synthetic trading target | No suitable existing application; no employer-owned material or Forge reuse. |
| Include pricing, credit and order management | Their asynchronous interactions are the domain problem. |
| Read-only target source access | Implementation clues may guide hypotheses; independent contracts define correctness. |
| Malformed structured messages included | Input rejection and business consistency are part of the target contract. |
| Delivery faults included | Duplicate and reordered messages can expose coupled-state errors. |
| Wire-level protocol faults excluded | No real FIX framing, checksums or transport adapters in this slice. |
| Reserve credit at acceptance | Overlapping commitments must share available capacity. |
| Later credit cuts affect future admissions | Existing commitments and executed trades remain binding. |
| Honour legitimate late-reported fills | Business occurrence differs from message arrival. |
| Interactive local application | Launching and inspecting investigations is part of the demonstration. |
| Direct Meta Model API preferred | Participant reports an activated $150 promotional credit grant. |
| No personal API spending authorised | Bound application usage and verify remaining promotional credit. |
| Scripted mock for offline work | Reproducible development, never evidence of autonomous discovery. |
| Feedback within an investigation | Persistent cross-session application knowledge is outside the MVP. |
| Verified reproductions establish product value | Beating a single-pass AI review is not a mandatory hurdle. |
| Conventional baseline remains required | Comparable results with comparable preparation would undermine the value claim. |

The local source/contract/event interface is an MVP boundary, not a general protocol-adapter architecture. Black-box investigation, production deployment and autonomous source modification remain future work.
