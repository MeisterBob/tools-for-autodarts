/**
 * WebSocket message capture utility
 * This script will be injected into the page to capture WebSocket messages
 */

// Script to be injected into the page
export const websocketCaptureScript = `
(function() {
  // Store the original WebSocket constructor
  const OriginalWebSocket = window.WebSocket;
  
  // Create a proxy to intercept WebSocket messages
  window.WebSocket = function(url, protocols) {
    const socket = new OriginalWebSocket(url, protocols);
    
    // Intercept the send method
    const originalSend = socket.send;
    socket.send = function(data) {
      try {
        // Log outgoing messages
        console.log('Autodarts Tools: Websocket: [WebSocket Outgoing]', {
          url,
          data: typeof data === 'string' ? data : '(binary data)',
          timestamp: new Date().toISOString()
        });
        
        // Dispatch a custom event with the outgoing message
        window.dispatchEvent(new CustomEvent('websocket-outgoing', {
          detail: {
            url,
            data: typeof data === 'string' ? data : '(binary data)',
            timestamp: new Date().toISOString()
          }
        }));
      } catch (error) {
        console.error('Autodarts Tools: Websocket: Error intercepting WebSocket send:', error);
      }
      
      // Call the original send method
      return originalSend.apply(this, arguments);
    };
    
    // Intercept the onmessage event
    socket.addEventListener('message', function(event) {
      try {
        // Log incoming messages
        console.log('Autodarts Tools: Websocket: [WebSocket Incoming]', {
          url,
          data: typeof event.data === 'string' ? event.data : '(binary data)',
          timestamp: new Date().toISOString()
        });
        
        // Dispatch a custom event with the incoming message
        window.dispatchEvent(new CustomEvent('websocket-incoming', {
          detail: {
            url,
            data: typeof event.data === 'string' ? event.data : '(binary data)',
            timestamp: new Date().toISOString()
          }
        }));
      } catch (error) {
        console.error('Autodarts Tools: Websocket: Error intercepting WebSocket message:', error);
      }
    });
    
    return socket;
  };
  
  // Copy properties from the original WebSocket to the new one
  for (const prop in OriginalWebSocket) {
    if (OriginalWebSocket.hasOwnProperty(prop)) {
      window.WebSocket[prop] = OriginalWebSocket[prop];
    }
  }
  
  // Set the prototype
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  
  console.log('Autodarts Tools: Websocket: [WebSocket Capture] Initialized');
})();
`;

// Function to inject the script into the page
export async function injectWebSocketCapture() {
  try {
    await browser.scripting.executeScript({
      target: { tabId: browser.devtools?.inspectedWindow?.tabId },
      func: () => {
        const script = document.createElement("script");
        script.textContent = websocketCaptureScript;
        document.documentElement.appendChild(script);
        script.remove();
      },
    });
    console.log("Autodarts Tools: Websocket: WebSocket capture script injected successfully");
  } catch (error) {
    console.error("Autodarts Tools: Websocket: Failed to inject WebSocket capture script:", error);
  }
}
