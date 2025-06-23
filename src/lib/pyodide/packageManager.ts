/**
 * Pyodide Package Manager
 * Handles preloading and caching of Pyodide packages
 */

import { browser } from '$app/environment';

/**
 * Cache object for package state
 */
type PackageCache = {
  loaded: Set<string>;
  loading: Set<string>;
  failed: Set<string>;
};

const packageCache: PackageCache = {
  loaded: new Set<string>(),
  loading: new Set<string>(),
  failed: new Set<string>()
};

/**
 * Checks if a package is already loaded
 */
export function isPackageLoaded(packageName: string): boolean {
  return packageCache.loaded.has(packageName);
}

/**
 * Saves loaded package to cache 
 */
export function markPackageAsLoaded(packageName: string): void {
  packageCache.loading.delete(packageName);
  packageCache.loaded.add(packageName);
}

/**
 * Marks a package as failed to load
 */
export function markPackageAsFailed(packageName: string): void {
  packageCache.loading.delete(packageName);
  packageCache.failed.add(packageName);
}

/**
 * Gets the predefined package list from the server
 */
export async function getPredefinedPackages(): Promise<string[]> {
  if (!browser) return [];
  
  try {
    const response = await fetch('/api/pyodide/packages');
    const data = await response.json();
    return data.packages || [];
  } catch (error) {
    console.error('Failed to fetch predefined Pyodide packages:', error);
    return [];
  }
}

/**
 * Checks if the browser cache contains a package
 */
export function checkPackageInCache(packageName: string): boolean {
  // This is a placeholder - actual implementation would check IndexedDB or other storage
  return false;
}
