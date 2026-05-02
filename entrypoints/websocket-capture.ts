/**
 * WebSocket capture script to be injected into the main world
 */

export default defineUnlistedScript(() => {
  console.log("Autodarts Tools: WebSocket Capture: Starting initialization");

  try {
    // Get the original data property descriptor
    const property = Object.getOwnPropertyDescriptor(
      MessageEvent.prototype,
      "data",
    );

    if (!property || !property.get) {
      console.error("Autodarts Tools: WebSocket Capture: Could not get data property descriptor");
      return;
    }

    const originalGetter = property.get;

    // Create a wrapper function that intercepts the getter
    function interceptMessageData(this: MessageEvent) {
      // Check if this is a WebSocket message
      const isWebSocket = this.currentTarget instanceof WebSocket;

      if (!isWebSocket) {
        return originalGetter.call(this);
      }

      // Get the original message data
      const messageData = originalGetter.call(this);

      try {
        // Only dispatch event, no logging here
        if (typeof messageData === "string") {
          try {
            // Try to parse JSON data to validate it's JSON
            JSON.parse(messageData);
            // No logging here, only in content script
          } catch (e) {
            // Not valid JSON, don't process
          }
        }

        // Dispatch a custom event with the message data
        window.dispatchEvent(new CustomEvent("websocket-incoming", {
          detail: {
            url: (this.currentTarget as WebSocket).url,
            data: typeof messageData === "string" ? messageData : "(binary data)",
            timestamp: new Date().toISOString(),
          },
        }));
      } catch (error) {
        console.error("Autodarts Tools: WebSocket Capture: Error processing message:", error);
      }

      // Return the original message data without trying to modify the property
      return messageData;
    }

    // Replace the getter with our interceptor
    property.get = interceptMessageData;
    Object.defineProperty(MessageEvent.prototype, "data", property);

    // Also intercept WebSocket.send to capture outgoing messages
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (
      this: WebSocket,
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ) {
      try {
        // Only dispatch event, no logging here
        if (typeof data === "string") {
          try {
            // Try to parse JSON data to validate it's JSON
            JSON.parse(data);
            // No logging here, only in content script
          } catch (e) {
            // Not valid JSON, don't process
          }
        }

        // Dispatch a custom event with the outgoing message
        window.dispatchEvent(new CustomEvent("websocket-outgoing", {
          detail: {
            url: this.url,
            data: typeof data === "string" ? data : "(binary data)",
            timestamp: new Date().toISOString(),
          },
        }));
      } catch (error) {
        console.error("Autodarts Tools: WebSocket Capture: Error intercepting send:", error);
      }

      // Call the original send method
      return originalSend.call(this, data);
    };

    console.log("Autodarts Tools: WebSocket Capture: Initialized successfully");
  } catch (error) {
    console.error("Autodarts Tools: WebSocket Capture: Initialization failed:", error);
  }
});
