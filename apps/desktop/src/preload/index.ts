import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("stubwise", { platform: process.platform });
