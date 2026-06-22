/**
 * Content script that injects the WebSocket capture script
 */
import { processWebSocketMessage } from "@/utils/websocket-helpers";

export default defineContentScript({
  matches: [ "*://play.autodarts.io/*" ],
  runAt: "document_start",
  async main(ctx) {
    console.log("Autodarts Tools: Websocket: Injecting WebSocket capture script...");

    // Set up event listeners BEFORE injecting the script to avoid race conditions
    // This is critical for WXT 0.20.13+ where injectScript waits for script to load
    ctx.addEventListener(window, "websocket-incoming", (event: CustomEvent) => {
      const { data } = event.detail;

      // Only process string data that can be parsed as JSON
      if (typeof data === "string") {
        try {
          // Try to parse JSON data
          const jsonData = JSON.parse(data);
          console.log("Autodarts Tools: Content Script: Parsed JSON data:", jsonData);
          processWebSocketMessage(jsonData.channel, jsonData.data).catch(console.error);
        } catch (e) {
          // Not JSON data, don't log
        }
      }
    });

    // Listen for outgoing WebSocket messages
    ctx.addEventListener(window, "websocket-outgoing", (event: CustomEvent) => {
      const { data } = event.detail;

      // Only process string data that can be parsed as JSON
      if (typeof data === "string") {
        try {
          // Try to parse JSON data
          const jsonData = JSON.parse(data);
          // Commented out logging for outgoing messages
          // console.log("Autodarts Tools: Content Script: Sent Parsed JSON:", jsonData);
        } catch (e) {
          // Not JSON data, don't log
        }
      }
    });

    try {
      // Inject the script into the page after event listeners are ready
      await injectScript("/websocket-capture.js", {
        keepInDom: true,
      });

      console.log("Autodarts Tools: Websocket: capture script injected successfully");
    } catch (error) {
      console.error("Autodarts Tools: Websocket: Failed to inject WebSocket capture script:", error);
    }
  },
});
