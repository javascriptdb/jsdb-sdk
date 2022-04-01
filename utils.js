import _ from "lodash-es";

export async function serializeFiles(data) {
  if (data) {
    for await(let [property, value] of Object.entries(data)) {
      if (value instanceof File) {
        data[property] = await fileToBase64(value);
      } else if (Array.isArray(value)) { // Array
        await value.map(async (arrayValue, index) => {
          if (_.isPlainObject(arrayValue)) {
            await serializeFiles(arrayValue);
          } else if (arrayValue instanceof File) {
            value[index] = await fileToBase64(arrayValue)
          }
        });
      } else if (_.isPlainObject(value)) { // Is an object, not a reference nor a date!
        await serializeFiles(value)
      }
    }
  }
}

export async function parseFiles(data) {
  if (data) {
    for await(let [property, value] of Object.entries(data)) {
      if (value?.customType === 'file') {
        data[property] = await base64ToFile(value);
      } else if (Array.isArray(value)) { // Array
        await value.map(async (arrayValue, index) => {
          if (_.isPlainObject(arrayValue)) {
            await serializeFiles(arrayValue);
          } else if (value?.customType === 'file') {
            value[index] = await base64ToFile(arrayValue)
          }
        });
      } else if (_.isPlainObject(value)) { // Is an object, not a reference nor a date!
        await serializeFiles(value)
      }
    }
  }
}

const fileToBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onload = () => resolve({customType: 'file', dataUrl: reader.result, name: file.name, type: file.type});
  reader.onerror = error => reject(error);
});

const base64ToFile = (base64)=> fetch(base64.dataUrl)
  .then(res => res.blob())
  .then(blob => {
    return new File([blob], base64.name,{ type: base64.type })
  })

