import { create } from 'zustand';

export interface CalibreSyncStatus {
  running: boolean;
  fetched: number;
  total?: number;
  added?: number;
  updated?: number;
  removed?: number;
  /** While running: fetched/total count books sent to the server. */
  sending?: boolean;
  sent?: number;
  finishedAt?: number;
  error?: string;
}

export const useCalibreSyncStore = create<{ byServer: Record<string, CalibreSyncStatus> }>(() => ({
  byServer: {},
}));

export const setCalibreSyncStatus = (id: string, status: CalibreSyncStatus) =>
  useCalibreSyncStore.setState((state) => ({ byServer: { ...state.byServer, [id]: status } }));
