import bcrypt from 'bcryptjs'
import { invalidateAdminAccount } from '../../../../utils/admin-account'

// s223: middleware admin-session сверяет сессию с учёткой (кэш 30 с). Любая правка
// учётки — в панели Strapi или с сервера — сбрасывает кэш, чтобы отключение, смена
// роли или логина действовали с первого же запроса.
const dropAccountCache = () => invalidateAdminAccount()

// Готовый bcrypt-хэш (карточка сотрудника, s225, хеширует пароль сама — чтобы пароль
// не зависел от того, прошёл ли запрос через lifecycle) повторно не хешируется.
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/
const isBcryptHash = (v: unknown) => typeof v === 'string' && BCRYPT_HASH.test(v)

export default {
  // Хешируем пароль перед созданием
  async beforeCreate(event) {
    const { data } = event.params

    if (data.password && !isBcryptHash(data.password)) {
      const salt = await bcrypt.genSalt(10)
      data.password = await bcrypt.hash(data.password, salt)
    }
  },

  // Хешируем пароль перед обновлением (только если пароль изменился)
  async beforeUpdate(event) {
    const { data } = event.params

    if (data.password) {
      // Проверяем, не хеширован ли уже пароль
      if (!isBcryptHash(data.password)) {
        const salt = await bcrypt.genSalt(10)
        data.password = await bcrypt.hash(data.password, salt)
      }
    }
  },

  // Логируем изменение статуса isActive
  async afterUpdate(event) {
    dropAccountCache()
    const { result, params } = event

    if (params.data?.isActive === false) {
      console.log(`User ${result?.username} (ID: ${result?.id}) has been deactivated`)
    }
  },

  async afterUpdateMany() {
    dropAccountCache()
  },

  async afterDelete() {
    dropAccountCache()
  },

  async afterDeleteMany() {
    dropAccountCache()
  },
}
