# `realtime/`

Transport for pushing auction state to connected clients (Phase 11): SSE/
WebSocket fan-out for the website, and outbound message dispatch for Telegram.

Realtime is a _delivery_ concern. It reads state that modules have already
committed; it never computes auction results, and it never reveals live bid
uniqueness — the payloads it may publish are restricted to what an in-flight
auction is allowed to disclose.
