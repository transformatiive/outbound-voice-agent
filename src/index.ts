import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { TelnyxHttpClient } from "./telnyx/client.js";

const config = loadConfig(process.env);
const telnyx = new TelnyxHttpClient({
  apiKey: config.telnyxApiKey,
  apiBase: config.telnyxApiBase,
});
const { app, attach } = createApp({ config, telnyx });
const server = createServer(app);
attach(server);

server.listen(config.port, () => {
  console.log(
    `outbound-voice-agent on :${config.port} (Grok ${config.grokModel} voice ${config.grokVoice}, from ${config.fromNumber}, outbound ready=${config.ready.outbound})`,
  );
});
