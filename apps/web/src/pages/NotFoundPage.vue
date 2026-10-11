<template>
  <div class="page">
    <header class="page-header">
      <h1>Page not found</h1>
    </header>
    <p>There is nothing at this address.</p>
    <router-link :to="{ name: 'home' }">Back to Today</router-link>
  </div>
</template>
