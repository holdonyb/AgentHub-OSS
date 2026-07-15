# Per-device Background Push Design

## Problem

AgentHub currently stores one notification state per user. A Web tab, the compatibility Android client, or the React Native client can mark that shared record delivered. This creates a race in which a foreground Web client can prevent a phone from showing the same approval or completion notification. The React Native client also polls only while its JavaScript runtime is active, so suspension or process termination stops delivery.

## Product Contract

- The existing user-level notification record remains the inbox/read/acknowledgement source of truth.
- Mobile delivery is tracked separately for every registered device.
- Registering a device does not enqueue notifications created before registration.
- Web delivery or read state never consumes a mobile device delivery.
- A disabled or invalid device is removed from future delivery without deleting inbox history.
- Self-host installations without push configuration continue to use the foreground/local notification path.
- A push tap opens the associated session and marks the user-level notification read.

## Data Model

`PushDevice` belongs to one space and user. It stores a client-generated stable device id, platform, transport, Expo push token, app version, enabled state, and last-seen timestamps. The token is operational routing data, never returned from list APIs, logs, audit payloads, or error responses.

`NotificationDelivery` joins a `NotificationRecord` to a `PushDevice`. Its state machine is:

```text
queued -> sending -> ticketed -> checking_receipt -> delivered
             |           |             |
             +-> retry ---+             +-> ticketed (bounded retry)
             +-> failed                 +-> failed
             +-> disabled <-------------+
```

The unique `(notification_record_id, push_device_id)` constraint prevents duplicate delivery. Delivery creation happens only for devices enabled at notification creation time, which prevents historical replay after installation or upgrade.

## Server Flow

1. An audit transition creates the existing per-user `NotificationRecord`.
2. The same transaction creates `NotificationDelivery` rows for currently enabled devices owned by that recipient.
3. A bounded dispatcher claims queued/retry rows atomically, sends batches to Expo Push, and persists ticket ids or retry state.
4. A receipt pass checks ticketed rows after the provider delay. `DeviceNotRegistered` disables the device and all unsent rows; transient provider errors use bounded exponential backoff.
5. The dispatcher is optional. With no Expo configuration, queued rows remain available and the React Native foreground fallback continues to work.

The first implementation exposes one authenticated maintenance endpoint for deterministic dispatch and invokes the same service from the API lifecycle loop. This keeps tests deterministic and lets self-host operators inspect/retry without adding another process.

## React Native Flow

After login and notification permission grant, the app obtains a stable local device id from SecureStore and an Expo push token using the configured EAS project id. It upserts the device through the authenticated API. If the installation changes accounts after an expired session, a device-id ownership conflict rotates the local id once; the server atomically disables any older active registration for the same Expo token so the previous account cannot continue sending to that installation. If permission, project id, or token acquisition is unavailable, registration is skipped and foreground ledger polling remains active.

Push payloads contain only `notificationId`, `sessionId`, type, title, and bounded body text. Notification taps reuse the existing cold-start/live response path. Logout revokes the current device registration before local authentication state is cleared when the network is available; server-side token rotation and device expiry remain additional safeguards.

## Security And Operations

- Device APIs require a normal authenticated user and CSRF on mutations.
- A user can update or revoke only devices bound to their own user and space. Possession of the same opaque Expo token may move that delivery endpoint to a newly authenticated account, disabling the old endpoint without exposing its owner or history.
- Push tokens are redacted from API responses, events, and logs.
- Provider access tokens are server environment configuration only.
- Payloads contain no local paths, raw tool output, secrets, or full transcripts.
- Retry limits and batch sizes are configurable and bounded.

## Validation

- Fresh and upgraded SQLite schemas include both new tables and indexes.
- API tests prove device ownership, idempotent upsert, no historical replay, per-device isolation, and revocation.
- Dispatcher tests use an injected HTTP transport and cover success, transient failure, malformed responses, and `DeviceNotRegistered`.
- React Native tests cover project-id absence, permission denial, idempotent registration, logout revocation, and tap deep-linking.
- CI compiles Android and iOS. Physical background delivery is not claimed until a signed build, Expo credentials, and a real device complete the smoke run.
