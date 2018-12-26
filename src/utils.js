function hasPermission(user, permissionsNeeded) {
  const matchedPermissions = user.permissions.filter(permissionTheyHave =>
    permissionsNeeded.includes(permissionTheyHave)
  );
  if (!matchedPermissions.length) {
    throw new Error(`You do not have sufficient permissions

      : ${permissionsNeeded}

      You Have:

      ${user.permissions}
      `);
  }
}

function checkCharacters(value, min, max, toCheck) {
  min = min || 5;
  max = max || 15;
  if (value.length <= min) {
    throw new Error(`Your ${toCheck} should have a minimum of ${min} characters.`)
  }
  if (value.length >= max) {
    throw new Error(`Your ${toCheck} should have a maximum of ${max} characters.`)
  }
}
exports.hasPermission = hasPermission;
exports.checkCharacters = checkCharacters;
