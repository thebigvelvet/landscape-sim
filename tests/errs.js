await new Promise((r) => setTimeout(r, 3000));
return { n: window.__gpuErrors, msgs: (window.__gpuErrorMsgs || []).map((m) => String(m).slice(0, 1500)) };
