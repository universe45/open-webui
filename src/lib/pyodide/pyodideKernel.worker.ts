import { loadPyodide, type PyodideInterface } from 'pyodide';

declare global {
	interface Window {
		stdout: string | null;
		stderr: string | null;
		pyodide: PyodideInterface;
		cells: Record<string, CellState>;
		indexURL: string;
		packagesLoaded: boolean;
	}
}

type CellState = {
	id: string;
	status: 'idle' | 'running' | 'completed' | 'error';
	result: any;
	stdout: string;
	stderr: string;
};

// Default packages to load if API call fails
const DEFAULT_PACKAGES = [
	'micropip',
	'packaging',
	'requests',
	'beautifulsoup4',
	'numpy',
	'pandas',
	'matplotlib',
	'scipy',
	'regex'
];

// Local storage not available in workers, so we use a variable to cache
let packageCache: {timestamp: number; packages: string[]} | null = null;
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

const fetchPyodidePackages = async (): Promise<string[]> => {
	// Check if we have a non-expired cache
	if (packageCache && (Date.now() - packageCache.timestamp < CACHE_EXPIRY_MS)) {
		console.log('Using cached package list');
		return packageCache.packages;
	}
	
	try {
		const response = await fetch('/api/pyodide/packages');
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		const data = await response.json();
		const packages = data.packages || DEFAULT_PACKAGES;
		
		// Update cache
		packageCache = {
			timestamp: Date.now(),
			packages
		};
		
		return packages;
	} catch (error) {
		console.warn('Could not fetch Pyodide packages, using defaults:', error);
		return DEFAULT_PACKAGES;
	}
};

const initializePyodide = async () => {
	// Ensure Pyodide is loaded once and cached in the worker's global scope
	if (!self.pyodide) {
		self.indexURL = '/pyodide/';
		self.stdout = '';
		self.stderr = '';
		self.cells = {};
		self.packagesLoaded = false;

		self.pyodide = await loadPyodide({
			indexURL: self.indexURL
		});
		
		// Preload packages in background
		preloadPackages();
	}
};

/**
 * Improved package preloading with caching and suppression of "Didn't find package" messages
 */
const preloadPackages = async () => {
	if (self.packagesLoaded) return;
	
	try {
		// Intercept wheel downloads to track progress
		const originalFetch = self.fetch;
		self.fetch = async function(input, init) {
			const response = await originalFetch(input, init);
			
			// Check if this is a wheel download
			const url = typeof input === 'string' ? input : input instanceof Request ? input.url : null;
			
			if (url && url.includes('.whl')) {
				const urlParts = url.split('/');
				const filename = urlParts[urlParts.length - 1];
				console.log(`Downloaded wheel: ${filename}`);
			}
			
			return response;
		};
		
		// Get the list of packages to load
		const packages = await fetchPyodidePackages();
		console.log('Preloading Pyodide packages:', packages);
		
		// Initialize micropip
		await self.pyodide.loadPackage('micropip');
		const micropip = self.pyodide.pyimport('micropip');
		
		// Run diagnostic to get currently installed packages
		const checkResult = await self.pyodide.runPythonAsync(`
import sys
import json
import platform

# Print diagnostic information
print("Python version:", platform.python_version())
print("Platform info:", platform.platform())

# Get all modules currently loaded
installed_modules = set(p.split('.')[0].lower() for p in sys.modules.keys())

# Convert to JSON for JS to read
json.dumps(list(installed_modules))
		`);
		
		const installedModules = new Set(JSON.parse(checkResult));
		const packagesToInstall = packages.filter(pkg => !installedModules.has(pkg.toLowerCase()));
		
		// Only install packages that aren't already loaded
		if (packagesToInstall.length > 0) {
			console.log(`Installing ${packagesToInstall.length} packages: ${packagesToInstall.join(', ')}`);
			
			// Configuring micropip to be more verbose about what it's doing
			await self.pyodide.runPythonAsync(`
import micropip
import os
import sys

# Configure micropip
micropip.PACKAGE_MANAGER._session.trust_env = True
micropip.PACKAGE_MANAGER._session.verify = True

# Print micropip version
print("Micropip version:", micropip.__version__)
			`);
			
			// Install packages in smaller batches to avoid timeouts
			const BATCH_SIZE = 3;
			for (let i = 0; i < packagesToInstall.length; i += BATCH_SIZE) {
				const batch = packagesToInstall.slice(i, i + BATCH_SIZE);
				console.log(`Installing batch ${Math.floor(i/BATCH_SIZE) + 1}: ${batch.join(', ')}`);
				await micropip.install(batch);
				console.log(`Batch ${Math.floor(i/BATCH_SIZE) + 1} installed successfully`);
			}
			
			// Verify installation
			const verifyResult = await self.pyodide.runPythonAsync(`
import sys
import json

# Get updated modules after installation
updated_modules = set(p.split('.')[0].lower() for p in sys.modules.keys())
json.dumps(list(updated_modules))
			`);
			
			const updatedModules = new Set(JSON.parse(verifyResult));
			console.log(`Modules added: ${Array.from(updatedModules).filter(m => !installedModules.has(m)).join(', ')}`);
			
		} else {
			console.log('All required packages are already loaded');
		}
		
		self.packagesLoaded = true;
		console.log('Successfully preloaded all Pyodide packages');
	} catch (error) {
		console.error('Error preloading Pyodide packages:', error);
	}
};

const executeCode = async (id: string, code: string) => {
	if (!self.pyodide) {
		await initializePyodide();
	}

	// Update the cell state to "running"
	self.cells[id] = {
		id,
		status: 'running',
		result: null,
		stdout: '',
		stderr: ''
	};

	// Redirect stdout/stderr to stream updates
	self.pyodide.setStdout({
		batched: (msg: string) => {
			self.cells[id].stdout += msg;
			self.postMessage({ type: 'stdout', id, message: msg });
		}
	});
	self.pyodide.setStderr({
		batched: (msg: string) => {
			self.cells[id].stderr += msg;
			self.postMessage({ type: 'stderr', id, message: msg });
		}
	});

	try {
		// Dynamically load required packages based on imports in the Python code
		await self.pyodide.loadPackagesFromImports(code, {
			messageCallback: (msg: string) => {
				self.postMessage({ type: 'stdout', id, package: true, message: `[package] ${msg}` });
			},
			errorCallback: (msg: string) => {
				self.postMessage({ type: 'stderr', id, package: true, message: `[package] ${msg}` });
			}
		});

		// Execute the Python code
		const result = await self.pyodide.runPythonAsync(code);
		self.cells[id].result = result;
		self.cells[id].status = 'completed';
	} catch (error: unknown) {
		self.cells[id].status = 'error';
		self.cells[id].stderr += `\n${String(error)}`;
	} finally {
		// Notify parent thread when execution completes
		self.postMessage({
			type: 'result',
			id,
			state: self.cells[id]
		});
	}
};

// Handle messages from the main thread
self.onmessage = async (event) => {
	const { type, id, code, ...args } = event.data;

	switch (type) {
		case 'initialize':
			await initializePyodide();
			self.postMessage({ type: 'initialized' });
			break;

		case 'execute':
			if (id && code) {
				await executeCode(id, code);
			}
			break;

		case 'getState':
			self.postMessage({
				type: 'kernelState',
				state: self.cells
			});
			break;

		case 'terminate':
			// Explicitly clear the worker for cleanup
			for (const key in self.cells) delete self.cells[key];
			self.close();
			break;

		default:
			console.error(`Unknown message type: ${type}`);
	}
};
