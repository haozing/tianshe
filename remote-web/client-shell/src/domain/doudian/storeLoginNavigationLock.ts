type StoreLoginNavigationLockListener = (locked: boolean) => void;

let locked = false;
const listeners = new Set<StoreLoginNavigationLockListener>();

export function isStoreLoginNavigationLocked() {
  return locked;
}

export function setStoreLoginNavigationLocked(next: boolean) {
  if (locked === next) return;
  locked = next;
  listeners.forEach((listener) => listener(locked));
}

export function subscribeStoreLoginNavigationLock(listener: StoreLoginNavigationLockListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
