// Importing necessary modules and resources
import '/public/assets/styles/global.css';
import './modules/PreProduction/index.js';
import './modules/Production/index.js';
import './modules/PostProduction/index.js';

// Initialize app
document.addEventListener('DOMContentLoaded', function() {
    console.log('Open Source Film Production Manager - Initialized');

    // Call any general initialization code here
    initializeApp();
});

function initializeApp() {
    // Placeholder for any global initialization code
    // Example: load the preproduction module, check authentication, etc.
    console.log('Initializing modules...');
}
