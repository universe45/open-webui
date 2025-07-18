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
	'black',
	'openai'
];

import { loadPyodide } from 'pyodide';
import { setGlobalDispatcher, ProxyAgent } from 'undici';
import { writeFile, readFile, copyFile, readdir, rmdir, mkdir, access } from 'fs/promises';
import { constants } from 'fs';

// Set to true to enable verbose logging
const VERBOSE = process.env.PYODIDE_VERBOSE === 'true';

// Suppress console.log during pyodide loading
const originalConsoleLog = console.log;
if (!VERBOSE) {
  // Temporarily override console.log to filter out Pyodide loading messages
  console.log = (...args) => {
    const message = args.join(' ');
    if (message.includes('Loading ') || message.includes('Loaded ') || 
        message.includes('already loaded')) {
      // Skip these messages
      return;
    }
    originalConsoleLog(...args);
  };
}

/**
 * Console color codes for terminal output
 */
const colors = {
	reset: '\x1b[0m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	magenta: '\x1b[35m',
	cyan: '\x1b[36m',
	red: '\x1b[31m'
};

/**
 * Log helper functions to reduce verbosity when not needed
 */
const logger = {
	info: (message) => {
		if (VERBOSE) {
			originalConsoleLog(message);
		}
	},
	warn: (message) => {
		console.warn(`${colors.yellow}[pyodide] WARNING: ${message}${colors.reset}`);
	},
	error: (message, err) => {
		console.error(`${colors.red}[pyodide] ERROR: ${message}${err ? ': ' + err.message : ''}${colors.reset}`);
	},
	success: (message) => {
		originalConsoleLog(`${colors.green}[pyodide] SUCCESS: ${message}${colors.reset}`);
	},
	step: (message) => {
		originalConsoleLog(`${colors.blue}[pyodide] STEP: ${message}${colors.reset}`);
	}
};

/**
 * Make sure a directory exists
 */
async function ensureDir(dir) {
	try {
		await access(dir, constants.F_OK);
	} catch {
		await mkdir(dir, { recursive: true });
	}
}

/**
 * Loading network proxy configurations from the environment variables.
 * And the proxy config with lowercase name has the highest priority to use.
 */
function initNetworkProxyFromEnv() {
	// we assume all subsequent requests in this script are HTTPS
	const allProxy = process.env.all_proxy || process.env.ALL_PROXY;
	const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
	const httpProxy = process.env.http_proxy || process.env.HTTP_PROXY;
	const preferedProxy = httpsProxy || allProxy || httpProxy;
	
	if (!preferedProxy || !preferedProxy.startsWith('http')) return;
	
	let preferedProxyURL;
	try {
		preferedProxyURL = new URL(preferedProxy).toString();
	} catch {
		logger.warn(`Invalid network proxy URL: "${preferedProxy}"`);
		return;
	}
	
	const dispatcher = new ProxyAgent({ uri: preferedProxyURL });
	setGlobalDispatcher(dispatcher);
	logger.info(`Initialized network proxy "${preferedProxy}" from env`);
}

async function downloadPackages() {
	originalConsoleLog(`${colors.blue}[pyodide] Setting up pyodide...${colors.reset}`);
	await ensureDir('static/pyodide');

	let pyodide;
	try {
		pyodide = await loadPyodide({
			packageCacheDir: 'static/pyodide',
			stdout: VERBOSE ? originalConsoleLog : () => {},  // Only show stdout if verbose
			stderr: (msg) => logger.warn(msg)  // Always show errors but with formatting
		});
	} catch (err) {
		logger.error('Failed to load Pyodide', err);
		return;
	}

	try {
		const packageJson = JSON.parse(await readFile('package.json'));
		const pyodideVersion = packageJson.dependencies.pyodide.replace('^', '');

		try {
			const pyodidePackageJson = JSON.parse(await readFile('static/pyodide/package.json'));
			const pyodidePackageVersion = pyodidePackageJson.version.replace('^', '');

			if (pyodideVersion !== pyodidePackageVersion) {
				logger.info('Pyodide version mismatch, removing static/pyodide directory');
				await rmdir('static/pyodide', { recursive: true });
				await ensureDir('static/pyodide');
			}
		} catch {
			// This is expected on first run, no need to show an error
			logger.info('Initializing pyodide directory');
		}

		try {
			originalConsoleLog(`${colors.cyan}[pyodide] Installing dependencies...${colors.reset}`);
			await pyodide.loadPackage('micropip');
			const micropip = pyodide.pyimport('micropip');
			
			// Install packages with less verbose output
			try {
				for (const pkg of packages) {
					logger.info(`Installing package: ${pkg}`);
					await micropip.install(pkg);
				}
				originalConsoleLog(`${colors.green}[pyodide] All packages installed successfully${colors.reset}`);
			} catch (err) {
				logger.error('Package installation failed', err);
				return;
			}

			try {
				const lockFile = await micropip.freeze();
				await writeFile('static/pyodide/pyodide-lock.json', lockFile);
			} catch (err) {
				logger.error('Failed to write lock file', err);
			}
		} catch (err) {
			logger.error('Failed to load or install micropip', err);
		}
	} catch (err) {
		logger.error('Failed to process package.json', err);
	}
}

async function copyPyodide() {
	originalConsoleLog(`${colors.blue}[pyodide] Copying Pyodide files...${colors.reset}`);
	
	try {
		// Ensure the target directory exists
		await ensureDir('static/pyodide');
		
		// Copy all files from node_modules/pyodide to static/pyodide
		for await (const entry of await readdir('node_modules/pyodide')) {
			try {
				await copyFile(`node_modules/pyodide/${entry}`, `static/pyodide/${entry}`);
			} catch (err) {
				logger.warn(`Failed to copy ${entry}: ${err.message}`);
			}
		}
		
		originalConsoleLog(`${colors.green}[pyodide] Setup complete${colors.reset}`);
	} catch (err) {
		logger.error('Failed to copy Pyodide files', err);
	}
}

try {
	initNetworkProxyFromEnv();
	await downloadPackages();
	await copyPyodide();
} catch (err) {
	logger.error('Unexpected error during Pyodide setup', err);
	process.exit(1);
} finally {
	// Restore the original console.log
	console.log = originalConsoleLog;
}
