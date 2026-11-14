# HackPrinceton Fall 2026 sponsor and track targets (proposed)

**Status:** proposed, written 2026-11-12. As of that date the [HackPrinceton site](https://www.hackprinceton.com/) lists the tracks and sponsors and "$15K+ in prizes," but **not what each sponsor prize rewards**. Check Devpost or the opening ceremony and update this page before committing work to a sponsor integration.

## Tracks

Education, Entertainment, Sustainability, **Healthcare**, Business + Enterprise, Science + Discovery. Clara's main track is **Healthcare**.

## Sponsor fit

| Sponsor | Fit | How Clara could use it | Extra work |
| --- | --- | --- | --- |
| **Amazon (AWS)** | Strong | Call Claude through **Amazon Bedrock**, and host cloud sync (hub → AWS when a link exists) for an NGO-wide view of all boxes and supply use | Low: swap the API client, add one sync endpoint |
| **Scale AI** | Strong | **Evaluation set:** about 100 spoken-style lines (messy, multilingual, panicked) labeled with the correct step or tool call; report step-selection accuracy in the pitch | Medium; also improves the product |
| **LangChain** | Good | **LangSmith** tracing of every agent turn and tool call (cheaper), or the agent loop in **LangGraph** | Low (tracing) to medium (LangGraph) |
| **Salesforce** | Possible | Push incidents and restock requests into Salesforce as NGO case management | Medium; outside the core demo |
| **CoStar Group** | Unclear | Real-estate and location data company; possibly box placement or map | Depends on their prize |
| Capital One, D. E. Shaw, Photon, Peri, Arlequin, ChatOverflow, Projects Board, COS Department, Justin Bojarski | Unknown | Check their prizes at the event; some may be general awards | — |

## Recommendation

Target **Healthcare + AWS + Scale AI**, which reinforce each other: Claude on Bedrock, an evaluation set that proves step-selection accuracy, and cloud sync on AWS for supply planning. Add LangSmith tracing if it is quick to set up. Skip Salesforce or other integrations unless their prize is large and specific.

## Cautions

- Confirm that `claude-opus-5-5` is available on Bedrock in the chosen AWS region before switching. Bedrock model IDs use the `anthropic.` prefix.
- Every integration is a dependency that can fail during the live demo. Keep a config switch back to the direct Anthropic API and to local-only hub mode.
- Sponsor work belongs in hours 26–30 of the [build order](software-plan.md), after the offline core works.
