import bcrypt from 'bcryptjs'

export default {
  // Хешируем пароль перед созданием
  async beforeCreate(event) {
    const { data } = event.params

    if (data.password) {
      const salt = await bcrypt.genSalt(10)
      data.password = await bcrypt.hash(data.password, salt)
    }
  },

  // Хешируем пароль перед обновлением (только если пароль изменился)
  async beforeUpdate(event) {
    const { data } = event.params

    if (data.password) {
      // Проверяем, не хеширован ли уже пароль (bcrypt хеши начинаются с $2)
      if (!data.password.startsWith('$2')) {
        const salt = await bcrypt.genSalt(10)
        data.password = await bcrypt.hash(data.password, salt)
      }
    }
  },

  // Логируем изменение статуса isActive
  async afterUpdate(event) {
    const { result, params } = event

    if (params.data.isActive === false) {
      console.log(`User ${result.username} (ID: ${result.id}) has been deactivated`)
    }
  },
}
