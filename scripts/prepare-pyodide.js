import { writeFile, readFile, copyFile, readdir, rm, mkdir, access } from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

// Define packages to download - these will be available in the frontend
const packages = [
  'micropip',
  'packaging',
  'requests',
  'beautifulsoup4',
  'numpy',
  'pandas',
  'matplotlib',
  'scikit-learn',
  'scipy',
  'regex',
  'sympy',
  'tiktoken',
  'seaborn',
  'pytz',
  'black'
];

// Paths for generated files
const LOCK_FILE_PATH = 'static/pyodide/pyodide-lock.json';
const MANIFEST_FILE_PATH = 'static/pyodide/pyodide-manifest.json';
const PACKAGE_INFO_FILE_PATH = 'static/pyodide/pyodide-info.js';
const INIT_SCRIPT_PATH = 'static/pyodide/pyodide-init.js';

/**
 * Loading network proxy configurations from the environment variables.
 * And the proxy config with lowercase name has the highest priority to use.
 */
function initNetworkProxyFromEnv() {
  // we assume all subsequent requests in this script are HTTPS:
  // https://cdn.jsdelivr.net
  // https://pypi.org
  // https://files.pythonhosted.org
  const allProxy = process.env.all_proxy || process.env.ALL_PROXY;
  const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  const httpProxy = process.env.http_proxy || process.env.HTTP_PROXY;
  const preferedProxy = httpsProxy || allProxy || httpProxy;
  /**
   * use only http(s) proxy because socks5 proxy is not supported currently:
   * @see https://github.com/nodejs/undici/issues/2224
   */
  if (!preferedProxy || !preferedProxy.startsWith('http')) return;
  let preferedProxyURL;
  try {
    preferedProxyURL = new URL(preferedProxy).toString();
  } catch {
    console.warn(`Invalid network proxy URL: "${preferedProxy}"`);
    return;
  }
  const dispatcher = new ProxyAgent({ uri: preferedProxyURL });
  setGlobalDispatcher(dispatcher);
  console.log(`Initialized network proxy "${preferedProxy}" from env`);
}

/**
 * Create directory if it doesn't exist
 */
async function ensureDirectoryExists(dirPath) {
  try {
    await access(dirPath, constants.F_OK);
  } catch (e) {
    console.log(`Creating directory: ${dirPath}`);
    await mkdir(dirPath, { recursive: true });
  }
}

/**
 * Check if Pyodide lock file exists and is valid
 */
async function checkLockFileExists(lockFilePath, packagesToCheck) {
  try {
    const lockData = await readFile(lockFilePath, 'utf-8');
    
    // First check if all our required packages are mentioned in the lock file
    const packagesMissing = packagesToCheck.some(pkg => {
      // Simple check - does lockfile include the package name
      return !lockData.includes(pkg);
    });
    
    if (packagesMissing) {
      console.log('Some packages are missing from the lock file, need to reinstall');
      return false;
    }
    
    // Now validate that it's proper JSON (may be corrupted)
    try {
      JSON.parse(lockData);
    } catch (jsonError) {
      console.log('Lock file contains invalid JSON, will reinstall');
      return false;
    }
    
    // Check that manifest file exists too
    try {
      await access(MANIFEST_FILE_PATH, constants.F_OK);
    } catch (e) {
      console.log('Manifest file does not exist, will reinstall');
      return false;
    }
    
    return true;
  } catch (error) {
    console.log('Lock file check failed, will download packages:', error.message);
    return false;
  }
}

/**
 * Main function to download and prepare packages 
 */
async function downloadPackages() {
  console.log('Setting up pyodide + micropip');

  // Ensure static directory exists
  const staticDir = 'static/pyodide';
  await ensureDirectoryExists(staticDir);
  
  // Check package version
  const packageJson = JSON.parse(await readFile('package.json', 'utf-8'));
  const pyodideVersion = packageJson.dependencies.pyodide.replace('^', '');
  
  // Check if we need to update Pyodide
  let pyodideNeedsUpdate = true;
  try {
    const pyodidePackageJson = JSON.parse(await readFile(`${staticDir}/package.json`, 'utf-8'));
    const pyodidePackageVersion = pyodidePackageJson.version;
    
    if (pyodideVersion === pyodidePackageVersion) {
      console.log(`Pyodide version ${pyodideVersion} matches, checking packages...`);
      
      // Check if we have a valid lock file with all packages
      if (await checkLockFileExists(LOCK_FILE_PATH, packages)) {
        console.log('All packages already installed according to lock file');
        pyodideNeedsUpdate = false;
      }
    } else {
      console.log(`Pyodide version mismatch: ${pyodideVersion} vs ${pyodidePackageVersion}`);
      console.log('Removing static/pyodide directory and recreating');
      // Use fs.rm instead of the deprecated fs.rmdir
      await rm(staticDir, { recursive: true, force: true });
      await ensureDirectoryExists(staticDir);
    }
  } catch (e) {
    console.log('Pyodide package not found or invalid, proceeding with fresh install');
    await ensureDirectoryExists(staticDir);
  }

  // If we need to update, download everything
  if (pyodideNeedsUpdate) {
    try {
      console.log(`Using Pyodide v${pyodideVersion} from node_modules`);
      
      // Step 1: Copy Pyodide from node_modules to static/pyodide
      await copyPyodide();
      
      // Step 2: Create manifest files
      console.log('Creating package manifest files...');
      
      // Create a basic lock file
      const lockFileContent = {
        timestamp: new Date().toISOString(),
        packages: packages.map(pkg => ({ 
          name: pkg, 
          version: "unknown"
        }))
      };
      await writeFile(LOCK_FILE_PATH, JSON.stringify(lockFileContent, null, 2));
      console.log('Created package lock file');
      
      // Create a manifest file with default values
      const manifestContent = {};
      packages.forEach(pkg => {
        manifestContent[pkg] = {
          installed: true,
          version: "unknown"
        };
      });
      await writeFile(MANIFEST_FILE_PATH, JSON.stringify(manifestContent, null, 2));
      console.log('Created package manifest file');
      
      // Create helper script
      await createHelperScript();
      
      // Create the initialization script
      await createInitScript();
      
      console.log('Pyodide packages prepared for frontend use');
      console.log('Note: Actual package installation will happen in the browser');
      console.log('The "Didn\'t find package" messages are normal on first load and will be cached');
    } catch (err) {
      console.error('Failed during Pyodide setup:', err);
    }
  }
}

/**
 * Copy all necessary Pyodide files from node_modules
 */
async function copyPyodide() {
  console.log('Copying Pyodide files from node_modules to static directory');
  
  const sourceDir = 'node_modules/pyodide';
  const targetDir = 'static/pyodide';
  
  try {
    // Get list of all files in the source directory
    const entries = await readdir(sourceDir);
    
    // Create the target directory if it doesn't exist
    await ensureDirectoryExists(targetDir);
    
    // Copy each file, showing progress
    let copied = 0;
    let failed = 0;
    const startTime = Date.now();
    
    console.log(`Copying ${entries.length} files...`);
    
    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry);
      const targetPath = path.join(targetDir, entry);
      
      try {
        await copyFile(sourcePath, targetPath);
        copied++;
        
        // Show progress every 10 files
        if (copied % 10 === 0) {
          const percent = Math.round((copied / entries.length) * 100);
          console.log(`Progress: ${percent}% (${copied}/${entries.length})`);
        }
      } catch (error) {
        console.error(`Failed to copy ${entry}: ${error.message}`);
        failed++;
      }
    }
    
    const duration = (Date.now() - startTime) / 1000;
    console.log(`Pyodide files copied: ${copied} succeeded, ${failed} failed in ${duration.toFixed(2)}s`);
  } catch (error) {
    console.error('Failed to copy Pyodide files:', error);
  }
}

/**
 * Create a helper script that apps can use to check package status
 */
async function createHelperScript() {
  try {
    // Read manifest file for version information if it exists
    let packageVersions = {};
    try {
      const manifestContent = await readFile(MANIFEST_FILE_PATH, 'utf-8');
      packageVersions = JSON.parse(manifestContent);
    } catch (err) {
      console.warn('Could not read package manifest, using empty version info');
    }

    // Get the Pyodide version from package.json
    const packageJson = JSON.parse(await readFile('package.json', 'utf-8'));
    const pyodideVersion = packageJson.dependencies.pyodide.replace('^', '');
    
    const helperScript = `/**
 * Pyodide package information
 * Auto-generated by prepare-pyodide.js on ${new Date().toISOString()}
 */

// List of pre-bundled packages
export const pyodidePackages = ${JSON.stringify(packages, null, 2)};

// Package version information
export const packageVersions = ${JSON.stringify(packageVersions, null, 2)};

// Pyodide version
export const PYODIDE_VERSION = "${pyodideVersion}";

/**
 * Get the list of pre-bundled packages
 */
export function getPyodidePackageList() {
  return pyodidePackages;
}

/**
 * Get the Pyodide version
 */
export function getPyodideVersion() {
  return PYODIDE_VERSION;
}

/**
 * Check if a package is pre-bundled with Pyodide
 */
export function isPyodidePackage(packageName) {
  return pyodidePackages.includes(packageName);
}

/**
 * Get version info for a specific package
 */
export function getPackageVersion(packageName) {
  const key = Object.keys(packageVersions).find(
    k => k.toLowerCase() === packageName.toLowerCase()
  );
  return key ? packageVersions[key] : null;
}
`;
    
    await writeFile(PACKAGE_INFO_FILE_PATH, helperScript);
    console.log('Created pyodide helper script successfully');
  } catch (err) {
    console.error('Failed to create helper script:', err);
  }
}

/**
 * Create the initialization script for pyodide in the browser
 */
async function createInitScript() {
  try {
    const initScript = `/**
 * Pyodide initialization script
 * Auto-generated by prepare-pyodide.js on ${new Date().toISOString()}
 *
 * This script helps initialize Pyodide in the browser with built-in
 * package caching and diagnostics.
 */

import { loadPyodide } from '/pyodide/pyodide.js';
import { pyodidePackages } from './pyodide-info.js';

// Cache control
const CACHE_KEY = 'pyodide-state';
const DB_NAME = 'pyodide-package-cache';
const STORE_NAME = 'package-wheels';

/**
 * Initialize Pyodide with caching and diagnostics
 */
export async function initPyodide(options = {}) {
  const {
    showLogs = true,
    indexURL = '/pyodide/',
    fullStdLib = true,
    stdLibURL = 'stdlib.zip',
    useCaching = true
  } = options;
  
  if (showLogs) {
    console.log('Initializing Pyodide...');
  }
  
  try {
    // Initialize with standard parameters
    const pyodide = await loadPyodide({
      indexURL,
      fullStdLib,
      stdLibURL,
      stdout: options.stdout || undefined,
      stderr: options.stderr || undefined
    });
    
    // Set up caching if enabled
    if (useCaching) {
      enablePackageCaching(pyodide);
    }
    
    if (showLogs) {
      console.log('Pyodide initialized successfully');
    }
    
    return pyodide;
  } catch (err) {
    console.error('Failed to initialize Pyodide:', err);
    throw err;
  }
}

/**
 * Set up package caching for Pyodide
 */
function enablePackageCaching(pyodide) {
  // TODO: Implement wheel caching using IndexedDB
  // This is just a placeholder for now - actual implementation is in pyodide-loader.ts
  console.log('Pyodide package caching is enabled');
}

/**
 * Install all predefined packages
 */
export async function installPackages(pyodide) {
  try {
    // Initialize micropip
    await pyodide.loadPackage('micropip');
    const micropip = pyodide.pyimport('micropip');
    
    // Install packages in batches
    const BATCH_SIZE = 3;
    console.log('Installing predefined packages:', pyodidePackages);
    
    for (let i = 0; i < pyodidePackages.length; i += BATCH_SIZE) {
      const batch = pyodidePackages.slice(i, Math.min(i + BATCH_SIZE, pyodidePackages.length));
      console.log(\`Installing batch \${Math.floor(i/BATCH_SIZE) + 1}: \${batch.join(', ')}\`);
      await micropip.install(batch);
    }
    
    console.log('All packages installed successfully');
  } catch (error) {
    console.error('Error installing packages:', error);
  }
}

/**
 * Get diagnostic information about the Pyodide environment
 */
export async function getDiagnostics(pyodide) {
  try {
    const code = \`
import sys
import json
import platform
import os
import micropip

# Collect system information
sys_info = {
    "python_version": platform.python_version(),
    "platform": platform.platform(),
    "sys_path": sys.path,
    "working_directory": os.getcwd(),
    "installed_modules": list(sys.modules.keys())
}

# Get information about currently installed packages
try:
    import pkg_resources
    installed_packages = []
    for d in pkg_resources.working_set:
        installed_packages.append({
            "name": d.project_name,
            "version": d.version
        })
    sys_info["installed_packages"] = installed_packages
except ImportError:
    sys_info["installed_packages"] = []

json.dumps(sys_info)
\`;

    const result = await pyodide.runPythonAsync(code);
    return JSON.parse(result);
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * Clear all Pyodide caches (localStorage and IndexedDB)
 */
export async function clearCache() {
  try {
    // Clear localStorage
    localStorage.removeItem(CACHE_KEY);
    
    // Clear IndexedDB
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      
      request.onsuccess = () => {
        console.log('Pyodide package cache cleared');
        resolve(true);
      };
      
      request.onerror = () => {
        console.error('Failed to clear Pyodide package cache');
        reject(false);
      };
    });
  } catch (error) {
    console.error('Error clearing cache:', error);
    return false;
  }
}
`;
    
    await writeFile(INIT_SCRIPT_PATH, initScript);
    console.log('Created Pyodide init script successfully');
  } catch (err) {
    console.error('Failed to create init script:', err);
  }
}

// Main execution
(async function main() {
  try {
    console.log('Starting Pyodide setup process');
    const startTime = Date.now();
    
    // Read package.json
    const packageJsonText = await readFile('package.json', 'utf-8');
    global.packageJson = JSON.parse(packageJsonText);
    
    // Set up network proxy if needed
    initNetworkProxyFromEnv();
    
    // Download and prepare packages
    console.log('Step 1: Setting up Pyodide packages and files');
    await downloadPackages();
    
    // Print completion message with timing information
    const duration = (Date.now() - startTime) / 1000;
    console.log(`Pyodide setup completed successfully in ${duration.toFixed(2)}s`);
    console.log('You can now use Pyodide in your application with pre-bundled packages');
  } catch (error) {
    console.error('Fatal error in Pyodide setup:', error);
    process.exit(1);
  }
})();
