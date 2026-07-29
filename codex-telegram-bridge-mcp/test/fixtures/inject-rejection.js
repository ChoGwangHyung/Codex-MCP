"use strict";

// Preloaded before the server entry point. The timer fires once the server has
// installed its process guards, simulating a background task whose promise
// rejects with nothing attached to it.
setTimeout(() => {
  Promise.reject(new Error("injected background rejection"));
}, 300);
