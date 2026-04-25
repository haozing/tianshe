import type { ElectronAPI } from '../../../../types/electron';

type FileAPI = ElectronAPI['file'];

function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('Electron API is not available. Make sure the preload script is loaded.');
  }
  return window.electronAPI;
}

function getFileApi(): FileAPI {
  return getElectronAPI().file;
}

export const fileFacade = {
  upload: (datasetId: string, fileData: Parameters<FileAPI['upload']>[1]) =>
    getFileApi().upload(datasetId, fileData),
  delete: (relativePath: string) => getFileApi().delete(relativePath),
  open: (relativePath: string) => getFileApi().open(relativePath),
  getImageData: (relativePath: string) => getFileApi().getImageData(relativePath),
};
