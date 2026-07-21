# [OPEN] Debug Session: twin-ui-server-check

## Scope
- Verify all machine data paths end-to-end: simulators -> PLC -> UNS -> MQTT -> ML -> Grafana/3D UI.
- Verify server health and UI responsiveness, including visible controls/cards.

## Symptoms
- The 3D twin cards remain stuck on `INITIALIZING`.
- Machine KPI values are not updating in the visible UI.
- User requested full verification of every machine and every server in detail.

## Initial Hypotheses
1. The ML inference service publishes no usable A1/A2/A3 analytics topics, so the 3D UI never receives updates.
2. MQTT/WebSocket connectivity is partially working, but the UI subscribes to topics that are not being produced or not yet retained.
3. One or more backend services are up but unhealthy in behavior, for example ML startup/runtime errors, causing only raw telemetry to flow.
4. The 3D UI has rendering/subscription success, but card update logic misses some payload shapes or machine topics.
5. Grafana is up, but datasource/dashboard wiring is incomplete or does not expose the ML analytics streams clearly enough.

## Evidence Plan
- Check live process/container status.
- Inspect ML/UNS runtime logs for topic publication and failures.
- Reproduce UI state in browser and inspect network/console behavior.
- Query MQTT traffic shape and confirm machine analytics topics exist.
- Apply the smallest possible fix only after evidence isolates the fault.
