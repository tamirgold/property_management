FROM frappe/erpnext:v15.103.0

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs npm yarnpkg \
  && ln -sf /usr/bin/yarnpkg /usr/local/bin/yarn \
  && ln -sf /usr/bin/yarnpkg /usr/bin/yarn \
  && yarn --version \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/local/bin:/usr/bin:${PATH}"

USER frappe
WORKDIR /home/frappe/frappe-bench

SHELL ["/bin/bash", "-lc"]

RUN set -euxo pipefail \
  && bench get-app --skip-assets --branch develop https://github.com/frappe/telephony \
  && ./env/bin/pip install --no-cache-dir -e apps/telephony \
  && bench get-app --skip-assets --branch main https://github.com/frappe/helpdesk \
  && ./env/bin/pip install --no-cache-dir -e apps/helpdesk \
  && git clone --depth 1 --branch version-15 https://github.com/aakvatech/PropMS apps/propms \
  && ./env/bin/pip install --no-cache-dir --no-deps -e apps/propms \
  && mkdir -p sites \
  && printf '{\"socketio_port\": 9000}\n' > sites/common_site_config.json \
  && bench build --app telephony \
  && bench build --app helpdesk
