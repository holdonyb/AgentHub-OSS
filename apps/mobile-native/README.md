# AgentHub Native Mobile

`apps/mobile-native` is the side-by-side React Native client foundation for AgentHub. It uses Expo 57 with Continuous Native Generation (CNG), so generated `android/` and `ios/` projects are not committed.

Current supported scope:

- first-launch self-host server configuration
- HTTPS validation with an explicit localhost/Tailscale HTTP development switch
- server configuration stored through `expo-secure-store`
- cookie-session login, restore check, logout, and server switching through `@agenthub/client-core`
- authenticated tab shell for Sessions, Tasks, Files, Workers, and Profile

The existing Capacitor app under `apps/mobile` remains the production Android client until native feature parity is verified.

The generated Android manifest allows cleartext transport so runtime-configured Tailscale addresses can work; application validation still rejects public HTTP origins. iOS limits its transport exception to local networking and `*.ts.net`.

## Requirements

- Node.js 20.19.4 or newer
- Android Studio for Android native builds
- macOS with Xcode for iOS native builds

## Commands

```bash
npm run mobile:native:test
npm run mobile:native:typecheck
npm run mobile:native:start
npm run mobile:native:prebuild
```

`prebuild` regenerates native projects locally. Do not commit those generated directories.
