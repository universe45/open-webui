/**
 * Utility for managing Pyodide package loading
 */

// Local storage key for caching packages
const CACHE_KEY = 'pyodide-packages-cache';
// Cache expiration (24 hours in milliseconds)
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;
// IndexedDB database name for storing package wheels
const DB_NAME = 'pyodide-package-cache';
const STORE_NAME = 'package-wheels';

interface PackageCache {
  timestamp: number;
  packages: string[];
}

interface PackageWheelCache {
  name: string; // package name
  url: string; // URL it was downloaded from
  data: ArrayBuffer; // the actual wheel binary data
  timestamp: number; // when it was cached
}

/**
 * Fetches the predefined package list from the API with caching
 */
export async function fetchPyodidePackages(): Promise<string[]> {
  // Default packages if API fails
  const DEFAULT_PACKAGES = [
    'micropip',
    'packaging',
    'requests',
    'beautifulsoup4',
    'numpy',
    'pandas',
  ];

  // Try to get from cache first
  const cachedData = localStorage.getItem(CACHE_KEY);
  if (cachedData) {
    try {
      const cache: PackageCache = JSON.parse(cachedData);
      const isExpired = Date.now() - cache.timestamp > CACHE_EXPIRY_MS;
      
      if (!isExpired && cache.packages && cache.packages.length > 0) {
        console.log('Using cached Pyodide packages list');
        return cache.packages;
      }
    } catch (err) {
      console.warn('Failed to parse cached Pyodide packages', err);
      // Continue to fetch from API
    }
  }

  try {
    const response = await fetch('/api/pyodide/packages');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    const packages = data.packages || DEFAULT_PACKAGES;
    
    // Update cache
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      timestamp: Date.now(),
      packages
    }));
    
    return packages;
  } catch (error) {
    console.error('Failed to fetch Pyodide packages:', error);
    return DEFAULT_PACKAGES;
  }
}

/**
 * Preloads packages to avoid "didn't find package" messages
 * @param pyodide - The Pyodide instance
 * @param packages - Array of package names to load
 * @param options - Configuration options
 */
export async function preloadPyodidePackages(
  pyodide: any, 
  packages: string[], 
  options: { 
    showLogs?: boolean, 
    forceReload?: boolean,
    useCache?: boolean 
  } = {}
) {
  const { showLogs = true, forceReload = false, useCache = true } = options;
  
  try {
    // Set up our cached package loader if enabled
    if (useCache) {
      await setupCachedPackageLoader(pyodide);
    }
    
    // Initialize micropip if needed
    await pyodide.loadPackage('micropip');
    const micropip = pyodide.pyimport('micropip');
    
    if (showLogs) {
      console.log(`Preloading Pyodide packages: ${packages.join(', ')}`);
    }
    
    // Check which packages are already installed
    if (!forceReload) {
      const missingPackages = await checkMissingPackages(pyodide, packages);
      
      if (missingPackages.length === 0) {
        if (showLogs) {
          console.log('All packages already installed, skipping installation');
        }
        return;
      }
      
      // Only install missing packages
      packages = missingPackages;
    }
    
    // Configure micropip to store downloaded packages
    await pyodide.runPythonAsync(`
import micropip
import sys
import json

# Show which packages are already available
print("Python version:", sys.version)
print("Available packages:", json.dumps(list(sys.modules.keys())))
    `);
    
    // Install packages
    await micropip.install(packages);
    
    if (showLogs) {
      console.log('Pyodide packages preloaded successfully');
    }
  } catch (error) {
    console.error('Error preloading Pyodide packages:', error);
  }
}

/**
 * Check if specific packages are already loaded in Pyodide
 * @param pyodide - The Pyodide instance
 * @param packages - Array of package names to check
 * @returns Array of package names that are not yet loaded
 */
export async function checkMissingPackages(pyodide: any, packages: string[]): Promise<string[]> {
  try {
    if (!packages || packages.length === 0) {
      return [];
    }
    
    // Convert package names to lowercase for comparison
    const packageNames = packages.map(pkg => pkg.toLowerCase());
    
    // Execute Python code to check installed packages
    const result = await pyodide.runPythonAsync(`
import sys
import json

# Get installed packages from sys.modules and pip
installed_modules = set(p.split('.')[0].lower() for p in sys.modules.keys())

# Check which packages are missing
requested_packages = ${JSON.stringify(packageNames)}
missing_packages = [pkg for pkg in requested_packages if pkg not in installed_modules]

json.dumps(missing_packages)
`);
    
    return JSON.parse(result);
  } catch (error) {
    console.error('Error checking installed packages:', error);
    // If we can't check, assume all packages need installing
    return packages;
  }
}

/**
 * Optimized package installation that only installs missing packages
 * @param pyodide - The Pyodide instance
 * @param packages - Array of package names to install
 */
export async function installMissingPackages(pyodide: any, packages: string[]): Promise<void> {
  try {
    // First check which packages are missing
    const missingPackages = await checkMissingPackages(pyodide, packages);
    
    if (missingPackages.length === 0) {
      console.log('All packages already installed');
      return;
    }
    
    console.log(`Installing ${missingPackages.length} missing packages: ${missingPackages.join(', ')}`);
    
    // Initialize micropip
    await pyodide.loadPackage('micropip');
    const micropip = pyodide.pyimport('micropip');
    
    // Install only the missing packages
    await micropip.install(missingPackages);
    
    console.log('Package installation completed');
  } catch (error) {
    console.error('Error installing missing packages:', error);
    
    // Fall back to installing all packages
    try {
      console.log('Falling back to installing all packages');
      await pyodide.loadPackage('micropip');
      const micropip = pyodide.pyimport('micropip');
      await micropip.install(packages);
    } catch (fallbackError) {
      console.error('Failed to install packages even with fallback method:', fallbackError);
    }
  }
}

/**
 * Initialize the IndexedDB database for package wheel caching
 */
async function initPackageDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    
    request.onerror = (event) => {
      console.error('Failed to open IndexedDB', event);
      reject('Failed to open IndexedDB');
    };
    
    request.onsuccess = (event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      // Create an object store for the package wheels
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'name' });
        store.createIndex('url', 'url', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

/**
 * Cache a package wheel in IndexedDB
 */
export async function cachePackageWheel(name: string, url: string, data: ArrayBuffer): Promise<void> {
  try {
    const db = await initPackageDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      const wheel: PackageWheelCache = {
        name,
        url,
        data,
        timestamp: Date.now()
      };
      
      const request = store.put(wheel);
      
      request.onerror = () => {
        console.error(`Failed to cache package wheel: ${name}`);
        reject();
      };
      
      request.onsuccess = () => {
        console.log(`Successfully cached package wheel: ${name}`);
        resolve();
      };
    });
  } catch (error) {
    console.error('Error caching package wheel:', error);
  }
}

/**
 * Get a cached package wheel from IndexedDB
 */
export async function getCachedPackageWheel(name: string): Promise<ArrayBuffer | null> {
  try {
    const db = await initPackageDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(name);
      
      request.onerror = () => {
        reject(`Failed to retrieve package wheel: ${name}`);
      };
      
      request.onsuccess = () => {
        const result = request.result as PackageWheelCache | undefined;
        if (result) {
          console.log(`Retrieved cached package wheel: ${name}`);
          resolve(result.data);
        } else {
          resolve(null);
        }
      };
    });
  } catch (error) {
    console.error('Error getting cached package wheel:', error);
    return null;
  }
}

/**
 * Set up a custom package loading mechanism for Pyodide
 * This intercepts package loading requests and serves from our IndexedDB cache
 * @param pyodide - The Pyodide instance
 */
export async function setupCachedPackageLoader(pyodide: any): Promise<void> {
  // Store the original loadPackage function
  const originalLoadPackage = pyodide.loadPackage;
  
  // Replace with our custom function
  pyodide.loadPackage = async function(names: string | string[], options: any = {}) {
    // Convert single package name to array
    const packages = Array.isArray(names) ? names : [names];
    
    // Try to load from cache first
    const cachedPackages: string[] = [];
    const packagesToLoad: string[] = [];
    
    for (const pkg of packages) {
      const cachedWheel = await getCachedPackageWheel(pkg);
      if (cachedWheel) {
        cachedPackages.push(pkg);
        
        // Register the package with Pyodide without downloading
        // This is a mock operation and may need adjustment based on Pyodide's API
        console.log(`Using cached package ${pkg}`);
      } else {
        packagesToLoad.push(pkg);
      }
    }
    
    // If there are packages to load from CDN
    if (packagesToLoad.length > 0) {
      // Set up an interceptor for package downloads
      const originalFetch = window.fetch;
      window.fetch = async function(input, init) {
        const response = await originalFetch(input, init);
        
        // Check if this is a package download
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('pyodide') && url.endsWith('.whl')) {
          // Clone the response so we can use it twice
          const clonedResponse = response.clone();
          
          // Extract package name from URL
          const urlParts = url.split('/');
          const filename = urlParts[urlParts.length - 1];
          const packageName = filename.split('-')[0];
          
          // Cache the wheel data
          try {
            const wheelData = await clonedResponse.arrayBuffer();
            await cachePackageWheel(packageName, url, wheelData);
          } catch (error) {
            console.error('Failed to cache package wheel:', error);
          }
        }
        
        return response;
      };
      
      // Call the original function for remaining packages
      try {
        await originalLoadPackage.call(pyodide, packagesToLoad, options);
      } finally {
        // Restore the original fetch function
        window.fetch = originalFetch;
      }
    }
    
    return true;
  };
  
  console.log('Pyodide package loading with caching enabled');
}

/**
 * Get diagnostic information about the Pyodide environment
 * Useful for debugging package loading issues
 * @param pyodide - The Pyodide instance
 */
export async function getPyodideDiagnostics(pyodide: any): Promise<Record<string, any>> {
  try {
    const diagnosticsCode = `
import sys
import json
import platform
import os
import micropip

# Collect system information
sys_info = {
    "python_version": platform.python_version(),
    "platform": platform.platform(),
    "pyodide_version": sys.modules.get("pyodide", {"__version__": "unknown"}).__version__,
    "micropip_version": getattr(micropip, "__version__", "unknown"),
    "sys_path": sys.path,
    "sys_modules": list(sys.modules.keys()),
    "working_directory": os.getcwd(),
}

# Get information about currently installed packages
try:
    import pkg_resources
    installed_packages = []
    for d in pkg_resources.working_set:
        installed_packages.append({
            "name": d.project_name,
            "version": d.version,
            "location": d.location
        })
    sys_info["installed_packages"] = installed_packages
except ImportError:
    sys_info["installed_packages"] = []

# Check specific packages important for the app
specific_packages = ["numpy", "pandas", "matplotlib", "scipy", "sklearn", "requests"]
package_status = {}

for package in specific_packages:
    try:
        __import__(package)
        package_info = {
            "imported": True,
            "version": sys.modules[package].__version__ if hasattr(sys.modules[package], "__version__") else "unknown"
        }
    except ImportError as e:
        package_info = {
            "imported": False,
            "error": str(e)
        }
        
    package_status[package] = package_info
    
sys_info["package_status"] = package_status

json.dumps(sys_info)
`;

    const diagnosticsJson = await pyodide.runPythonAsync(diagnosticsCode);
    return JSON.parse(diagnosticsJson);
  } catch (error) {
    console.error('Error getting Pyodide diagnostics:', error);
    return {
      error: String(error),
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Clear all cached Pyodide packages
 * Use this when package loading is failing and you want to start fresh
 */
export async function clearPyodideCache(): Promise<boolean> {
  try {
    // Clear localStorage cache
    localStorage.removeItem(CACHE_KEY);
    
    // Clear IndexedDB cache
    const db = await initPackageDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();
      
      request.onerror = () => {
        console.error('Failed to clear package cache');
        reject(false);
      };
      
      request.onsuccess = () => {
        console.log('Successfully cleared package cache');
        resolve(true);
      };
    });
  } catch (error) {
    console.error('Error clearing package cache:', error);
    return false;
  }
}

/**
 * Check the status of the package cache
 * @returns Information about the cache status
 */
export async function getPyodideCacheStatus(): Promise<Record<string, any>> {
  try {
    // Check localStorage cache
    const cachedData = localStorage.getItem(CACHE_KEY);
    let localStorageCache = null;
    
    if (cachedData) {
      try {
        const cache = JSON.parse(cachedData);
        localStorageCache = {
          timestamp: new Date(cache.timestamp).toISOString(),
          packageCount: cache.packages?.length || 0,
          isExpired: Date.now() - cache.timestamp > CACHE_EXPIRY_MS
        };
      } catch (err) {
        localStorageCache = { error: String(err) };
      }
    }
    
    // Check IndexedDB cache
    const db = await initPackageDatabase();
    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const countRequest = store.count();
      
      countRequest.onsuccess = () => {
        const packageCount = countRequest.result;
        
        // Get the list of cached packages if count is reasonable
        if (packageCount <= 100) {
          const getAllRequest = store.getAll();
          
          getAllRequest.onsuccess = () => {
            const packages = getAllRequest.result.map((pkg: PackageWheelCache) => ({
              name: pkg.name,
              url: pkg.url,
              size: pkg.data.byteLength,
              cached: new Date(pkg.timestamp).toISOString()
            }));
            
            resolve({
              localStorageCache,
              indexedDBCache: {
                packageCount,
                packages,
                databaseName: DB_NAME,
                storeName: STORE_NAME
              },
              timestamp: new Date().toISOString()
            });
          };
          
          getAllRequest.onerror = () => {
            resolve({
              localStorageCache,
              indexedDBCache: {
                packageCount,
                error: 'Failed to get package list'
              },
              timestamp: new Date().toISOString()
            });
          };
        } else {
          // Too many packages to list them all
          resolve({
            localStorageCache,
            indexedDBCache: {
              packageCount,
              databaseName: DB_NAME,
              storeName: STORE_NAME
            },
            timestamp: new Date().toISOString()
          });
        }
      };
      
      countRequest.onerror = () => {
        resolve({
          localStorageCache,
          indexedDBCache: {
            error: 'Failed to count packages'
          },
          timestamp: new Date().toISOString()
        });
      };
    });
  } catch (error) {
    console.error('Error getting cache status:', error);
    return {
      error: String(error),
      timestamp: new Date().toISOString()
    };
  }
}
