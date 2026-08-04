import { join } from "node:path";
import {
  ModelRuntime,
  type ExtensionContext,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";

export async function createChildModelRuntime(
  modelRegistry: ModelRegistry,
  model: NonNullable<ExtensionContext["model"]>,
  agentDir: string,
): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });

  for (const providerId of modelRegistry.getRegisteredProviderIds()) {
    const nativeProvider = modelRegistry.getRegisteredNativeProvider(providerId);
    if (nativeProvider) {
      modelRuntime.registerNativeProvider(nativeProvider);
    }
    const providerConfig = modelRegistry.getRegisteredProviderConfig(providerId);
    if (providerConfig) {
      modelRuntime.registerProvider(providerId, providerConfig);
    }
  }

  if (modelRegistry.getProviderAuthStatus(model.provider).source === "runtime") {
    const auth = await modelRegistry.getProviderAuth(model.provider);
    if (auth?.auth.apiKey) {
      await modelRuntime.setRuntimeApiKey(model.provider, auth.auth.apiKey, { allowNetwork: false });
    }
  }

  return modelRuntime;
}
