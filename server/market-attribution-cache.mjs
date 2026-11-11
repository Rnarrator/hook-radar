// One bounded structural generation for Store's published project records.
// It never supplies canonical pool membership or source measurement evidence.
export class MarketAttributionCache {
  #generation = null;
  #epoch = 0;

  constructor({
    maxProjects = 400000,
    maxDeployments = 500000,
    maxHooks = 50000,
  } = {}) {
    for (const [name, value] of Object.entries({
      maxProjects,
      maxDeployments,
      maxHooks,
    }))
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError(`${name} must be a nonnegative safe integer.`);
    this.limits = Object.freeze({ maxProjects, maxDeployments, maxHooks });
  }

  clear() {
    this.#epoch++;
    this.#generation = null;
  }

  get stats() {
    const current = this.#generation;
    return Object.freeze({
      projects: current?.ids.length || 0,
      deployments: current?.addresses.length || 0,
      hooks: current?.wanted.size || 0,
    });
  }

  *lookupSteps(projects, wanted) {
    const current = this.#generation;
    if (!current || projects.length !== current.ids.length) return null;
    for (const key of wanted) if (!current.wanted.has(key)) return null;
    let cursor = 0;
    let work = 0;
    for (let index = 0; index < projects.length; index++) {
      if (++work % 1024 === 0) yield;
      const project = projects[index];
      const deployments = project.deployments;
      if (
        project.id !== current.ids[index] ||
        deployments !== current.deployments[index] ||
        deployments.length !== current.lengths[index]
      )
        return null;
      // Published deployments are immutable. These scalar checks also reject
      // accidental in-place edits without rebuilding/lowercasing every key.
      for (const deployment of deployments) {
        if (++work % 1024 === 0) yield;
        if (
          deployment.chainId !== current.chainIds[cursor] ||
          deployment.address !== current.addresses[cursor] ||
          deployment.chain !== current.chains[cursor]
        )
          return null;
        cursor++;
      }
    }
    return current.owners;
  }

  begin(projects, wanted) {
    if (
      !this.limits.maxProjects ||
      !this.limits.maxDeployments ||
      !this.limits.maxHooks ||
      projects.length > this.limits.maxProjects ||
      wanted.size > this.limits.maxHooks
    ) {
      this.clear();
      return null;
    }
    return {
      ids: [],
      deployments: [],
      lengths: [],
      chainIds: [],
      addresses: [],
      chains: [],
      wanted: new Set(wanted),
      complete: true,
      epoch: this.#epoch,
    };
  }

  project(capture, id, deployments) {
    if (!capture?.complete) return;
    if (
      capture.ids.length >= this.limits.maxProjects ||
      capture.addresses.length + deployments.length > this.limits.maxDeployments
    ) {
      capture.complete = false;
      this.clear();
      return;
    }
    capture.ids.push(id);
    capture.deployments.push(deployments);
    capture.lengths.push(deployments.length);
  }

  deployment(capture, chainId, address, chain) {
    if (!capture?.complete) return;
    capture.chainIds.push(chainId);
    capture.addresses.push(address);
    capture.chains.push(chain);
  }

  commit(capture, owners) {
    if (!capture?.complete || capture.epoch !== this.#epoch) return;
    this.#generation = { ...capture, owners };
  }
}
