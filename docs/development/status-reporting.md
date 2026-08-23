# Dashboard status reporting

Dashboard status is a hierarchy of observations, selectors, and views. A view
must not infer process state from copy, component mount order, or a transport
failure. It consumes one of the shared selectors described here.

## Diagnostic layers

### Dashboard connection

`DashboardConnectionDiagnostics` answers whether this browser can currently
reach AoE. It is session-independent and remains meaningful when no session is
selected or while the selected session changes.

### Selected-session operation

`SessionOperationalState` describes the selected session. It first represents
session disposition, such as archived or snoozed, then the agent state when the
session is active. An online agent owns its nested turn state. Invalid
combinations are therefore not representable. For example, an archived session
cannot simultaneously expose an active turn.

Structured and terminal surfaces normalize their existing observations into
this same type. Protocol-specific connection hooks remain responsible for
collecting those observations.

### Selected-session transport

`SessionConnectionDiagnostics` describes the live stream used by the selected
surface. It contains the normalized operational state alongside transport
facts. The dashboard and optional session halves form a
`ConnectionStatusSnapshot`.

### Conversation policy

`ConversationDiagnosticsSnapshot` combines connection status with the optional
selected session. Its selectors answer two product questions:

- `deriveSessionIncident` chooses the single lifecycle incident and recovery
  action to present.
- `deriveComposerAvailability` chooses what submitting a message means now.

`deriveConversationNextStep` separately selects the transcript-tail state for
an online agent, such as working, scheduled, or monitoring.

## Data flow

```text
dashboard reachability ───────────────┐
                                      ├─ ConnectionStatusSnapshot
surface transport observations ──────┤          │
                                      │          ├─ top-bar indicator
session record + ACP reducer state ───┘          ├─ connection incident bubble
               │                                 └─ detail popout
               └─ SessionOperationalState
                            │
                            └─ ConversationDiagnosticsSnapshot
                                      ├─ lifecycle incident and action
                                      ├─ composer availability
                                      └─ transcript next step
```

The top-bar indicator, connection incident bubble, and detail popout are three
views of the same connection snapshot. They must not derive independent status.
The lifecycle notice, composer, and transcript tail similarly consume selectors
over the same selected-session operation.

## Priority rules

Operational state is selected in this order:

1. Session creation or deletion.
2. Trash, archive, or snooze disposition.
3. A pending user-requested agent operation.
4. An uncleared compatibility or startup failure.
5. A running worker and its current turn.
6. Resume, stop, dormancy, and recovery observations.
7. Explicit unavailability when no worker or transition is observed.

An existing worker process does not clear a startup failure. The existing
`AcpSessionAssigned` event is the handshake evidence that clears reducer failure
latches.

Connection selection evaluates the browser-to-AoE route before downstream
state. When AoE is unreachable, agent observations are shown only as last-known
detail. Once the route is current, a known absent worker is `Agent unavailable`,
not a healthy connection and not an indefinite starting state.

## Presentation ownership

- The connection views own transport progress, interruption detail, retry
  counts, and the `Reconnect` action. `Reconnect` always means retry the live
  stream.
- `LifecycleIncidentNotice` owns session and agent recovery presentation. Its
  actions use explicit labels such as `Start agent`, `Retry start`, `Restore`,
  `Unarchive`, and `Unsnooze`.
- `ConversationNextStepNotice` owns non-busy transcript-tail waiting states.
  Active work continues to use the inline working indicator.
- `ComposerActionRail` owns durable input outcomes: queued prompts, rejected
  prompts, option failures, and optional suggestions.
- A rejected message remains attached to its transcript row. It must not be
  represented as a connection or lifecycle failure.

Specialized remediation content may live inside a shared notice or dedicated
screen. It must still use the shared lifecycle action states: idle, pending,
accepted, and failed.

## Adding a status

1. Identify the existing observation that proves the state. Do not add a probe
   merely to drive presentation.
2. Add the state to the narrowest canonical model that owns it.
3. Update the selector priority with a table case that demonstrates what it
   outranks and what outranks it.
4. Reuse the appropriate presentation component.
5. Test the user-visible action transition when the status is actionable.

If a proposed status needs to be valid only under one parent state, nest it
under that parent instead of adding another independent boolean dimension.
