/**
 * @fileoverview Vite entrypoint for the self-contained MCP App dashboard bundle.
 * Imports dashboard CSS and initializes the MCP App bridge before bootstrapping the UI.
 */

import '../ui/dashboard/styles/index.css';
import './ui-bridge-entry.mjs';
import '../ui/dashboard/main.js';
