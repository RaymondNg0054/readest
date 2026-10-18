import type { CatalogUploadAdapter, CatalogUploadTarget } from '@/types/catalogUpload';

export async function createCatalogUploadAdapter(
  target: CatalogUploadTarget,
): Promise<CatalogUploadAdapter> {
  const { createCalibreWebUploadAdapter } = await import('./calibreWebUpload');
  return createCalibreWebUploadAdapter(target);
}
