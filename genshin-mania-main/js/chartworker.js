/* Runs SmartChart off the main thread so the page stays responsive while a
   song is analysed. Protocol:
     page -> worker  { mono: Float32Array (transferred), sampleRate, options }
     worker -> page  { type: "progress", pct }
                     { type: "done", chart }
                     { type: "error", code, message, bpm?, offsetMs? }
   Cancelling is done by the page calling worker.terminate(). */
importScripts("smartchart.js");

self.onmessage = async (event) => {
  const { mono, sampleRate, options } = event.data;
  try {
    const chart = await SmartChart.generate(mono, sampleRate, options, {
      onProgress: (pct) => self.postMessage({ type: "progress", pct }),
    });
    self.postMessage({ type: "done", chart });
  } catch (err) {
    self.postMessage({
      type: "error",
      code: (err && err.code) || "failed",
      message: String((err && err.message) || err),
      bpm: err && err.bpm,
      offsetMs: err && err.offsetMs,
    });
  }
};
