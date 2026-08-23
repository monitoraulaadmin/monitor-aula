import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail
} from 'firebase/auth';
import { onValue, ref } from 'firebase/database';
import { RolesService } from './roles.js';
import { auth, db } from '../config/firebase';

// Simple encryption/decryption for credentials (not military-grade but sufficient for lazy users)
const encryptData = (text) => {
  return btoa(text);
};

const decryptData = (text) => {
  try {
    return atob(text);
  } catch {
    return null;
  }
};

export const AuthService = {
  // Estado actual del usuario
  currentUser: null,
  isAdmin: false,
  lastVisitedClass: null,
  adminListenerUnsubscribe: null,
  authStateUnsubscribe: null,
  isManualLogout: false, // Flag para distinguir logout manual de sesión expirada

  // Save credentials to localStorage
  saveCredentials(email, password) {
    try {
      const credentials = {
        email: encryptData(email),
        password: encryptData(password),
        timestamp: Date.now()
      };
      localStorage.setItem('monitoraula_creds', JSON.stringify(credentials));
      console.log('✅ Credenciales guardadas en localStorage');
    } catch (error) {
      console.error('Error guardando credenciales:', error);
    }
  },

  // Get saved credentials from localStorage
  getSavedCredentials() {
    try {
      const stored = localStorage.getItem('monitoraula_creds');
      if (!stored) return null;

      const credentials = JSON.parse(stored);
      const email = decryptData(credentials.email);
      const password = decryptData(credentials.password);

      if (email && password) {
        console.log('✅ Credenciales recuperadas de localStorage');
        return { email, password };
      }
    } catch (error) {
      console.error('Error recuperando credenciales:', error);
    }
    return null;
  },

  // Clear saved credentials
  clearSavedCredentials() {
    try {
      localStorage.removeItem('monitoraula_creds');
      console.log('✅ Credenciales eliminadas de localStorage');
    } catch (error) {
      console.error('Error eliminando credenciales:', error);
    }
  },

  // Subscribe to auth state changes
  subscribeToAuthChanges(callback) {
    return onAuthStateChanged(auth, callback);
  },

  // Inicializar el servicio de autenticación con timeout
  async init() {
    return new Promise(async (resolve, reject) => {
      // Remove hard timeout to allow unlimited wait time for persistence
      // const initTimeout = setTimeout(...)

      try {
        // First, check if there's already a Firebase session
        if (auth.currentUser) {
          console.log('✅ Usuario ya autenticado en Firebase:', auth.currentUser.email);
          this.currentUser = auth.currentUser;


          // Load admin status and last visited class
          try {
            await this.updateAdminStatus();
            this.lastVisitedClass = await RolesService.getLastVisitedClass(auth.currentUser.email);
            this.listenForAdminChanges();
          } catch (statusError) {
            console.warn('⚠️ Error cargando estado del usuario:', statusError);
          }

          resolve(auth.currentUser);
          return;
        }

        // Try to login with saved credentials if available
        const savedCreds = this.getSavedCredentials();

        if (savedCreds) {
          console.log('🔄 Intentando auto-login con credenciales guardadas...');
          try {
            // Set a timeout for auto-login attempt
            const loginTimeout = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Login timeout')), 2000)
            );

            const loginPromise = this.login(savedCreds.email, savedCreds.password, false);

            await Promise.race([loginPromise, loginTimeout]);

            console.log('✅ Auto-login exitoso');
            resolve(this.currentUser);

            return;
          } catch (error) {
            console.error('❌ Auto-login falló:', error);
            this.clearSavedCredentials();
            // Continue to auth state listener
          }
        }

        // Set up auth state listener with timeout
        let authStateResolved = false;

        // Listen for auth state changes
        this.authStateUnsubscribe = onAuthStateChanged(auth, async (user) => {
          if (authStateResolved) return; // Prevent multiple resolutions

          authStateResolved = true;
          authStateResolved = true;


          this.currentUser = user;

          if (user) {
            console.log('✅ Usuario detectado por Firebase:', user.email);
            try {
              await this.updateAdminStatus();
              this.listenForAdminChanges();
              this.lastVisitedClass = await RolesService.getLastVisitedClass(user.email);
            } catch (error) {
              console.warn('⚠️ Error cargando datos del usuario:', error);
            }
          } else {
            console.log('ℹ️ No hay usuario autenticado');
            this.isAdmin = false;
            this.lastVisitedClass = null;
          }

          resolve(user);
        });

      } catch (error) {
        console.error('❌ Error en init:', error);
        console.error('❌ Error en init:', error);
        resolve(null);
      }
    });
  },

  async updateAdminStatus() {
    try {
      // Force a fresh check of admin status
      RolesService.invalidateAdminCache();
      const wasAdmin = this.isAdmin;
      this.isAdmin = await RolesService.isAdmin(this.currentUser);

      console.log('🔍 Admin status check:', {
        user: this.currentUser?.email,
        wasAdmin,
        isAdmin: this.isAdmin
      });

      if (wasAdmin !== this.isAdmin) {
        console.log('🔄 Admin status changed, dispatching event');
        window.dispatchEvent(new CustomEvent('admin-status-changed'));
      }
    } catch (error) {
      console.error('❌ Error actualizando estado de admin:', error);
      this.isAdmin = false;
    }
  },

  listenForAdminChanges() {
    try {
      if (this.adminListenerUnsubscribe) {
        this.adminListenerUnsubscribe();
      }

      // Listen for changes in both fixed and designated admins
      const fixedAdminsRef = ref(db, 'fixed_admins');
      const designatedAdminsRef = ref(db, 'designated_admins');

      const handleAdminChange = () => {
        console.log('🔄 Cambios detectados en admins, actualizando estado...');
        RolesService.invalidateAdminCache();
        this.updateAdminStatus();
      };

      // Set up listeners for both paths
      const unsubFixed = onValue(fixedAdminsRef, handleAdminChange);
      const unsubDesignated = onValue(designatedAdminsRef, handleAdminChange);

      // Store unsubscribe function that cleans up both listeners
      this.adminListenerUnsubscribe = () => {
        unsubFixed();
        unsubDesignated();
      };

      console.log('✅ Listeners de admin configurados');
    } catch (error) {
      console.error('❌ Error configurando listeners de admin:', error);
    }
  },

  // Iniciar sesión
  async login(email, password, saveCredentials = true) {
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      this.currentUser = userCredential.user;

      // Force a fresh check of admin status
      RolesService.invalidateAdminCache();
      this.isAdmin = await RolesService.isAdmin(userCredential.user);
      this.lastVisitedClass = await RolesService.getLastVisitedClass(email);

      console.log('✅ Login exitoso:', {
        user: email,
        isAdmin: this.isAdmin,
        lastClass: this.lastVisitedClass
      });

      // Set up admin change listeners
      this.listenForAdminChanges();

      // Save credentials for future auto-login (unless it's an auto-login attempt)
      if (saveCredentials) {
        this.saveCredentials(email, password);
      }

      return userCredential.user;
    } catch (error) {
      console.error('❌ Error al iniciar sesión:', error);
      throw this.translateError(error);
    }
  },

  // Cerrar sesión
  async logout() {
    try {
      if (this.adminListenerUnsubscribe) {
        this.adminListenerUnsubscribe();
      }
      if (this.authStateUnsubscribe) {
        this.authStateUnsubscribe();
      }

      // Marcar como logout manual ANTES de signOut
      this.isManualLogout = true;

      // Clear saved credentials on logout
      this.clearSavedCredentials();

      await signOut(auth);
      this.currentUser = null;
      this.isAdmin = false;
      this.lastVisitedClass = null;

      console.log('✅ Sesión cerrada correctamente');
    } catch (error) {
      console.error('❌ Error al cerrar sesión:', error);
      throw this.translateError(error);
    }
  },

  // Enviar email de restablecimiento de contraseña
  async sendPasswordReset(email) {
    try {
      await sendPasswordResetEmail(auth, email);
    } catch (error) {
      console.error('Error al enviar email de restablecimiento:', error);
      throw this.translateError(error);
    }
  },

  // Verificar si el usuario está autenticado
  isAuthenticated() {
    return !!this.currentUser;
  },

  // Obtener el usuario actual
  getCurrentUser() {
    return this.currentUser;
  },

  // Actualizar última clase visitada
  async updateLastVisitedClass(className) {
    if (this.currentUser?.email) {
      try {
        await RolesService.setLastVisitedClass(this.currentUser.email, className);
        this.lastVisitedClass = className;
      } catch (error) {
        console.error('Error actualizando última clase visitada:', error);
      }
    }
  },

  // Traducir errores de Firebase a mensajes amigables
  translateError(error) {
    const errorMessages = {
      'auth/invalid-email': 'El correo electrónico no es válido',
      'auth/user-disabled': 'Esta cuenta ha sido deshabilitada',
      'auth/user-not-found': 'No existe una cuenta con este correo electrónico',
      'auth/wrong-password': 'La contraseña es incorrecta',
      'auth/email-already-in-use': 'Este correo electrónico ya está en uso',
      'auth/operation-not-allowed': 'Operación no permitida',
      'auth/weak-password': 'La contraseña es demasiado débil',
      'auth/network-request-failed': 'Error de conexión. Verifica tu conexión a internet',
      'auth/too-many-requests': 'Demasiados intentos fallidos. Intenta más tarde',
      'auth/requires-recent-login': 'Por seguridad, vuelve a iniciar sesión',
      'auth/invalid-credential': 'Las credenciales son incorrectas'
    };

    return new Error(errorMessages[error.code] || error.message);
  }
};
