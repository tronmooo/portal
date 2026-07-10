# Combined-command stress — 2026-07-10T23:10:46.241Z

| # | Probe | Latency | HTTP | Tools | Items OK | Items failed | Verdict |
|---|-------|---------|------|-------|----------|--------------|---------|
| 1 | BP + heart rate dual log (regression of audit fix) | 4.8s | 200 | log_entry | BP entry 126/82 (no pulse inside) | Heart Rate entry 61 | PARTIAL |

**0/1 probes fully passed.** Partial = some items in the message executed, others silently didn't.