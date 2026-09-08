# `jobs/`

One file per BullMQ processor.

Auction closing is worker-driven: the API never closes an auction on a request
path. The closing job freezes the valid bid set inside a transaction, runs the
single `LUB_V1` implementation from `modules/results`, and writes an immutable
result row. It calls the same services the HTTP and Telegram channels call —
there is no worker-only copy of any business rule.

Processors land in Phase 6 (`auction.close`), Phase 9 (`payments.reconcile`)
and Phase 11 (`notifications.dispatch`).
