const { contextBridge, ipcRenderer } = require("electron");

const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("opencncAgent", {
  snapshot: () => ipcRenderer.invoke("agent:snapshot"),
  about: () => ipcRenderer.invoke("agent:about"),
  chooseParentFolder: () => ipcRenderer.invoke("agent:choose-parent-folder"),
  chooseMachineProfile: () => ipcRenderer.invoke("agent:choose-machine-profile"),
  updateConfiguration: configuration => ipcRenderer.invoke("agent:update-configuration", configuration),
  setAutomationEnabled: enabled => ipcRenderer.invoke("agent:set-enabled", enabled),
  runNow: () => ipcRenderer.invoke("agent:run-now"),
  openBppInBiesseWorks: jobId => ipcRenderer.invoke("agent:open-bpp-in-biesseworks", jobId),
  openProjectFolder: directory => ipcRenderer.invoke("agent:open-project-folder", directory),
  openProjectOutputFolder: directory => ipcRenderer.invoke("agent:open-project-output-folder", directory),
  openMonitoredFolder: () => ipcRenderer.invoke("agent:open-monitored-folder"),
  openDataFolder: () => ipcRenderer.invoke("agent:open-data-folder"),
  openOpenCnc: () => ipcRenderer.invoke("agent:open-opencnc"),
  onState: callback => subscribe("agent:state", callback),
  onBiesseWorksProgress: callback => subscribe("agent:biesseworks-progress", callback),
  onNavigate: callback => subscribe("agent:navigate", callback)
});
