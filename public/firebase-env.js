/**
 * firebase-env.js — PROD Firebase project identity.
 *
 * This file is what makes a deploy point at prod vs. dev: the dev CI job
 * overwrites it with firebase-env.dev.js before deploying (same
 * CI-time-substitution pattern as the __COMMIT_HASH__ stamp). Campaign
 * values stay in config.js, shared by both environments, so only the
 * project-identity block is duplicated across the two env files.
 *
 * None of these values are secrets — they identify which project to talk
 * to; access control is Firestore rules + Auth, not this file.
 */
window.FIREBASE_ENV = {
  apiKey: 'AIzaSyBbmp4gRn7fRIzFcK2nEgCy126Db0RhjB0',
  authDomain: 'daggerheart-campaign-codex.firebaseapp.com',
  projectId: 'daggerheart-campaign-codex',
  storageBucket: 'daggerheart-campaign-codex.firebasestorage.app',
  messagingSenderId: '621018661606',
  appId: '1:621018661606:web:3a4ac8abef07bae50bf127'
};
