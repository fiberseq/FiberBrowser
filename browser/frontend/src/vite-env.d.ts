/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build-time default of Settings › Reads & Display › Analysis panels: unset or 'rail' (the shipped default), or 'strip' (the classic strip). */
  readonly VITE_DEFAULT_PANEL_LAUNCHER?: string;
}
