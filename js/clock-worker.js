// Reloj en un worker: sus temporizadores no se ralentizan como los de la pestaña.
let timer = null;
self.onmessage = e => {
  if (e.data === 'start' && !timer) timer = setInterval(() => self.postMessage(0), 4);
  else if (e.data === 'stop' && timer) { clearInterval(timer); timer = null; }
};
