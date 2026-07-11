import { useEffect, useMemo, useState } from 'react';
import { AgentHubApiError } from '@agenthub/client-core';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createMobileApi, type NativeAuthPayload } from './api/mobileApi';
import { bootstrapSession } from './auth/bootstrapSession';
import type { AuthRoute } from './auth/authRoute';
import type { ServerConfig } from './config/serverConfig';
import { ServerConfigRepository } from './config/serverConfigRepository';
import { MainTabs } from './navigation/MainTabs';
import { LoadingScreen } from './screens/LoadingScreen';
import { LoginScreen } from './screens/LoginScreen';
import { ServerSetupScreen } from './screens/ServerSetupScreen';
import { expoSecureStore } from './storage/expoSecureStore';

interface RuntimeState {
  route: AuthRoute;
  config: ServerConfig | null;
  auth: NativeAuthPayload | null;
  error: string | null;
}

const repository = new ServerConfigRepository(expoSecureStore);

function loginErrorMessage(error: unknown): string {
  if (error instanceof AgentHubApiError && error.status === 401) return '邮箱或密码不正确';
  return error instanceof Error ? error.message : '登录失败';
}

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeState>({
    route: 'loading',
    config: null,
    auth: null,
    error: null,
  });
  const [busy, setBusy] = useState(false);
  const api = useMemo(
    () => runtime.config ? createMobileApi(runtime.config.serverUrl) : null,
    [runtime.config],
  );

  useEffect(() => {
    let active = true;
    void bootstrapSession(repository).then((result) => {
      if (active) setRuntime(result);
    });
    return () => {
      active = false;
    };
  }, []);

  async function handleServerSave(config: ServerConfig) {
    setBusy(true);
    try {
      const saved = await repository.save(config);
      setRuntime({ route: 'login', config: saved, auth: null, error: null });
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin(email: string, password: string) {
    if (!api || !runtime.config) return;
    setBusy(true);
    setRuntime((current) => ({ ...current, error: null }));
    try {
      const auth = await api.login(email, password);
      setRuntime({ route: 'main', config: runtime.config, auth, error: null });
    } catch (error) {
      setRuntime((current) => ({ ...current, route: 'login', error: loginErrorMessage(error) }));
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    if (!api || !runtime.config || !runtime.auth) return;
    setBusy(true);
    try {
      await api.logout(runtime.auth.csrf_token);
      setRuntime({ route: 'login', config: runtime.config, auth: null, error: null });
    } catch (error) {
      setRuntime((current) => ({ ...current, error: loginErrorMessage(error) }));
    } finally {
      setBusy(false);
    }
  }

  async function handleChangeServer() {
    setBusy(true);
    try {
      await repository.clear();
      setRuntime({ route: 'server-setup', config: null, auth: null, error: null });
    } catch (error) {
      setRuntime((current) => ({ ...current, error: loginErrorMessage(error) }));
    } finally {
      setBusy(false);
    }
  }

  let content;
  if (runtime.route === 'server-setup') {
    content = <ServerSetupScreen busy={busy} initialError={runtime.error} onSave={handleServerSave} />;
  } else if (runtime.route === 'login' && runtime.config) {
    content = (
      <LoginScreen
        busy={busy}
        error={runtime.error}
        onChangeServer={handleChangeServer}
        onLogin={handleLogin}
        serverUrl={runtime.config.serverUrl}
      />
    );
  } else if (runtime.route === 'main' && runtime.config && runtime.auth) {
    content = (
      <MainTabs
        busy={busy}
        error={runtime.error}
        onChangeServer={handleChangeServer}
        onLogout={handleLogout}
        serverUrl={runtime.config.serverUrl}
        user={runtime.auth.user}
      />
    );
  } else {
    content = <LoadingScreen />;
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {content}
    </SafeAreaProvider>
  );
}
