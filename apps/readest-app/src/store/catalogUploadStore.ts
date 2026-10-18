import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { CatalogUploadReceipt } from '@/types/catalogUpload';

interface CatalogUploadState {
  receipts: Record<string, CatalogUploadReceipt>;
  setReceipt: (receipt: CatalogUploadReceipt) => void;
  removeReceipt: (targetId: string, bookHash: string) => void;
}

export const catalogUploadReceiptKey = (targetId: string, bookHash: string) =>
  `${targetId}:${bookHash}`;

export const useCatalogUploadStore = create<CatalogUploadState>()(
  persist(
    (set) => ({
      receipts: {},
      setReceipt: (receipt) =>
        set((state) => ({
          receipts: {
            ...state.receipts,
            [catalogUploadReceiptKey(receipt.targetId, receipt.bookHash)]: receipt,
          },
        })),
      removeReceipt: (targetId, bookHash) =>
        set((state) => {
          const receipts = { ...state.receipts };
          delete receipts[catalogUploadReceiptKey(targetId, bookHash)];
          return { receipts };
        }),
    }),
    { name: 'readest-catalog-uploads', storage: createJSONStorage(() => localStorage) },
  ),
);

export const hasPendingCatalogUploads = (targetId: string) =>
  Object.values(useCatalogUploadStore.getState().receipts).some(
    (receipt) => receipt.targetId === targetId,
  );

export const CATALOG_UPLOAD_IMPORT_PAUSE_MS = 24 * 60 * 60_000;

export const isBlockingCatalogUpload = (
  receipt: CatalogUploadReceipt,
  now: number = Date.now(),
): boolean => receipt.startedAt == null || now - receipt.startedAt < CATALOG_UPLOAD_IMPORT_PAUSE_MS;

export const hasBlockingCatalogUploads = (targetId: string, now: number = Date.now()) =>
  Object.values(useCatalogUploadStore.getState().receipts).some(
    (receipt) => receipt.targetId === targetId && isBlockingCatalogUpload(receipt, now),
  );
